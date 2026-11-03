'use strict';
// AI news summaries and timeline per event (Phase 5B, PLAN P5.4; CLONE_SPEC.md §29.6). Built only from the platform's
// own news items (Admin › Content › News items, table cms_news).
//
//   provider   extractive (default, offline, deterministic) or an external adapter (server/ai-providers.js), chosen at
//              boot; tests inject a fake adapter through start({ marketsContent: { ai: { adapter } } }).
//   cache      ai_summaries keyed by (event, news-set hash): the SHA-256 of the active items' ids, times and text. A
//              cached summary is served until the set changes or an admin regenerates it.
//   cost caps  a daily request and token budget (admin_settings 'ai_summary'); usage per UTC day in ai_usage. When a
//              call would exceed it, the extractive summary is served instead (fallback_reason 'budget').
//   safety     news text is data: delimited, escaped input (ai-providers.buildPrompt); the output is validated —
//              JSON shape, 1..N sentences, bounded length, plain text (no HTML, links or markdown), every sentence cites
//              only ids that were provided, no instruction echo, a moderation blocklist. Anything that fails is
//              discarded and the extractive summary is served (fallback_reason 'invalid_output').
//   admin      list, hide / unhide (per event), regenerate (rate limited), settings — content.write / settings.write,
//              each with a reason and a hash-chained audit row.
const crypto = require('node:crypto');
const { newId, nowIso, ApiError, E } = require('./util');
const { check } = require('./validate');
const auditChain = require('./audit-chain');
const P = require('./ai-providers');
const { createLimiter } = require('./content-rate');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_summaries (id TEXT PRIMARY KEY, event_ticker TEXT NOT NULL, news_hash TEXT NOT NULL, provider TEXT NOT NULL, content_json TEXT NOT NULL,
  item_count INTEGER NOT NULL, fallback_reason TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, trigger TEXT NOT NULL DEFAULT 'read', created_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ai_summaries_event ON ai_summaries(event_ticker, news_hash, created_ts);
CREATE TABLE IF NOT EXISTS ai_summary_flags (event_ticker TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0);
`;
const DEFAULT_BLOCKLIST = ['guaranteed profit', 'risk-free', 'risk free', 'insider tip', 'can\'t lose', 'buy now', 'sell now', 'pump and dump'];
const DEFAULTS = { enabled: true, daily_request_limit: 100, daily_token_limit: 100000, max_items: 12, max_sentences: 3, max_chars: 900, blocklist: DEFAULT_BLOCKLIST };
const SETTINGS_SCHEMA = {
  enabled: { type: 'boolean' }, daily_request_limit: { type: 'integer', min: 0, max: 100000 }, daily_token_limit: { type: 'integer', min: 0, max: 100000000 },
  max_items: { type: 'integer', min: 1, max: 40 }, max_sentences: { type: 'integer', min: 1, max: 8 }, max_chars: { type: 'integer', min: 120, max: 3000 },
  blocklist: { type: 'array', maxItems: 100, items: { type: 'string', maxLen: 60 } }, reason: { type: 'string', maxLen: 500, required: true },
};
const REASON = { reason: { type: 'string', maxLen: 500, required: true } };
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

function mountAiSummary({ v1, db, engine, admin, getEvent, options = {} }) {
  db.exec(SCHEMA);
  // The external provider: an injected adapter (tests: a fake, or a function returning the adapter in use), else the
  // Claude adapter when both environment variables are set, else none (extractive only).
  const envAdapter = P.createAnthropicAdapter();
  const externalOf = () => (typeof options.adapter === 'function' ? options.adapter() : options.adapter) || envAdapter;
  const regenLimit = createLimiter(db, 'ai_regenerate', { limit: options.regeneratePer10Min ?? 6, windowMs: 10 * 60000 });
  const settings = () => { const r = db.prepare("SELECT value FROM admin_settings WHERE key='ai_summary'").get(); return { ...DEFAULTS, ...(r ? JSON.parse(r.value) : {}) }; };
  const saveSettings = (v, by) => db.prepare("INSERT INTO admin_settings(key,value,updated_at,updated_by) VALUES('ai_summary',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").run(JSON.stringify(v), nowIso(), by);
  const audit = (req, action, target, before, after, reason) => auditChain.append(db, { actor_id: req.auth.user.id, actor_email: req.auth.user.email, action, target_type: 'ai_summary', target_id: target, before, after, reason });
  const reasonOf = (b) => { const r = String(b.reason || '').trim(); if (r.length < 3) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };

  // ------------------------------------------------------------------ news set + hash
  const itemsOf = (t, max = settings().max_items) => db.prepare('SELECT id, source, published_at, headline, summary FROM cms_news WHERE event_ticker=? AND active=1 ORDER BY published_at DESC, position LIMIT ?').all(t, max);
  const hashOf = (items) => crypto.createHash('sha256').update(JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id)).map((i) => [i.id, i.published_at, i.source, i.headline, i.summary]))).digest('hex');
  const timelineOf = (items) => [...items].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.id.localeCompare(b.id)).map((i, k) => ({ n: k + 1, id: i.id, date: i.published_at, source: i.source, headline: i.headline }));

  // ------------------------------------------------------------------ usage / budget
  const usageToday = () => db.prepare('SELECT * FROM ai_usage WHERE day=?').get(day()) || { day: day(), requests: 0, input_tokens: 0, output_tokens: 0, fallbacks: 0, rejected: 0 };
  const bump = (col, n = 1) => db.prepare(`INSERT INTO ai_usage(day,${col}) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET ${col}=${col}+excluded.${col}`).run(day(), n);
  function withinBudget(estimate) {
    const s = settings(); const u = usageToday();
    return u.requests < s.daily_request_limit && u.input_tokens + u.output_tokens + estimate <= s.daily_token_limit;
  }

  // ------------------------------------------------------------------ output validation
  function blockedFn(s) { const list = (s.blocklist || []).map((x) => String(x).toLowerCase()).filter(Boolean); return (t) => { const l = t.toLowerCase(); return list.some((w) => l.includes(w)); }; }
  function validate(out, ids, s) {
    let obj = out.sentences ? out : null;
    if (!obj) {
      const text = String(out.text || '').trim();
      if (!text || text.length > 20000) return { ok: false, reason: 'empty_or_oversized' };
      const a = text.indexOf('{'); const b = text.lastIndexOf('}');
      if (a < 0 || b < a) return { ok: false, reason: 'not_json' };
      try { obj = JSON.parse(text.slice(a, b + 1)); } catch { return { ok: false, reason: 'not_json' }; }
    }
    if (!obj || !Array.isArray(obj.sentences) || !obj.sentences.length || obj.sentences.length > s.max_sentences) return { ok: false, reason: 'shape' };
    const blocked = blockedFn(s); let total = 0; const outS = [];
    for (const x of obj.sentences) {
      if (!x || typeof x.text !== 'string' || !Array.isArray(x.citations) || !x.citations.length || x.citations.length > 8) return { ok: false, reason: 'shape' };
      const t = x.text.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (t.length < 8 || t.length > 300) return { ok: false, reason: 'length' };
      if (/[<>]/.test(t) || /&[a-z#0-9]+;/i.test(t)) return { ok: false, reason: 'html' };
      if (P.URLISH.test(t)) return { ok: false, reason: 'link' };
      if (/[`*_#]{2,}|^\s*[-*]\s/.test(t)) return { ok: false, reason: 'markdown' };
      if (P.looksInjected(t)) return { ok: false, reason: 'instruction_echo' };
      if (blocked(t)) return { ok: false, reason: 'moderation' };
      if (x.citations.some((c) => typeof c !== 'string' || !ids.has(c))) return { ok: false, reason: 'unknown_citation' };
      total += t.length;
      outS.push({ text: t, citations: [...new Set(x.citations)] });
    }
    if (total > s.max_chars) return { ok: false, reason: 'length' };
    return { ok: true, sentences: outS };
  }

  // ------------------------------------------------------------------ generation
  const inflight = new Map();
  async function generate(ticker, items, hash, trigger) {
    const key = `${ticker}:${hash}`;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const s = settings(); const blocked = blockedFn(s);
      let provider = 'extractive'; let content = null; let fallback = ''; let usage = { input_tokens: 0, output_tokens: 0 };
      const external = externalOf();
      if (external && s.enabled) {
        const prompt = P.buildPrompt(items, s.max_sentences);
        const estimate = Math.ceil((prompt.system.length + prompt.user.length) / 4) + 1024;
        if (!withinBudget(estimate)) { fallback = 'budget'; bump('fallbacks'); } else {
          bump('requests');
          try {
            const out = await external.summarize({ items, maxSentences: s.max_sentences, system: prompt.system, user: prompt.user });
            usage = { input_tokens: Number(out.usage?.input_tokens) || 0, output_tokens: Number(out.usage?.output_tokens) || 0 };
            bump('input_tokens', usage.input_tokens); bump('output_tokens', usage.output_tokens);
            const v = validate(out, new Set(items.map((i) => i.id)), s);
            if (v.ok) { provider = external.name; content = { sentences: v.sentences }; } else { fallback = `invalid_output:${v.reason}`; bump('rejected'); bump('fallbacks'); }
          } catch (e) { fallback = `provider_error:${e.kind || 'error'}`; bump('fallbacks'); }
        }
      } else if (external && !s.enabled) fallback = 'disabled';
      if (!content) content = P.extractive(items, { maxSentences: s.max_sentences, blocked });
      const row = { id: newId('ais_'), event_ticker: ticker, news_hash: hash, provider, content_json: JSON.stringify(content), item_count: items.length, fallback_reason: fallback, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, trigger, created_ts: Date.now() };
      db.prepare('INSERT INTO ai_summaries(id,event_ticker,news_hash,provider,content_json,item_count,fallback_reason,input_tokens,output_tokens,trigger,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, row.event_ticker, row.news_hash, row.provider, row.content_json, row.item_count, row.fallback_reason, row.input_tokens, row.output_tokens, row.trigger, row.created_ts);
      // Keep the latest few per event.
      db.prepare('DELETE FROM ai_summaries WHERE event_ticker=? AND id NOT IN (SELECT id FROM ai_summaries WHERE event_ticker=? ORDER BY created_ts DESC LIMIT 5)').run(ticker, ticker);
      return row;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }
  const cached = (t, hash) => db.prepare('SELECT * FROM ai_summaries WHERE event_ticker=? AND news_hash=? ORDER BY created_ts DESC LIMIT 1').get(t, hash);
  const flagOf = (t) => db.prepare('SELECT * FROM ai_summary_flags WHERE event_ticker=?').get(t);
  const PROVIDER_LABEL = { extractive: P.extractiveProvider.label };
  function vo(row, items) {
    const tl = timelineOf(items); const num = new Map(tl.map((x) => [x.id, x.n]));
    const c = JSON.parse(row.content_json);
    return {
      id: row.id, provider: row.provider, provider_label: PROVIDER_LABEL[row.provider] || (externalOf() && row.provider === externalOf().name ? externalOf().label : row.provider),
      generated_time: new Date(row.created_ts).toISOString(), news_hash: row.news_hash, item_count: row.item_count, fallback_reason: row.fallback_reason || null,
      sentences: c.sentences.map((x) => ({ text: x.text, citations: x.citations.filter((id) => num.has(id)).map((id) => ({ id, n: num.get(id) })) })),
    };
  }
  async function summaryFor(t, { trigger = 'read' } = {}) {
    const items = itemsOf(t);
    const timeline = timelineOf(items);
    if (!items.length) return { event_ticker: t, summary: null, hidden: false, timeline };
    const f = flagOf(t);
    if (f && f.hidden) return { event_ticker: t, summary: null, hidden: true, timeline };
    const hash = hashOf(items);
    const row = cached(t, hash) || (await generate(t, items, hash, trigger));
    return { event_ticker: t, summary: vo(row, items), hidden: false, timeline };
  }
  const emit = (t, kind) => engine.emit('event_content', t, { event_ticker: t, kind, ts: Date.now() });

  // ------------------------------------------------------------------ public
  v1.get('/events/:ticker/ai_summary', async (req, res) => {
    const e = getEvent(String(req.params.ticker).toUpperCase());
    if (!e) throw E.notFound();
    res.json(await summaryFor(e.ticker));
  });

  // ------------------------------------------------------------------ admin
  const A = '/admin/ai_summaries';
  v1.get(A, admin.can('content.write'), (req, res) => {
    const evs = db.prepare('SELECT DISTINCT event_ticker t FROM cms_news WHERE active=1 ORDER BY event_ticker').all().map((r) => r.t);
    const rows = evs.map((t) => {
      const items = itemsOf(t); const hash = hashOf(items); const c = cached(t, hash); const f = flagOf(t); const e = getEvent(t);
      return { event_ticker: t, title: e ? e.title : t, items: items.length, hidden: !!(f && f.hidden), hidden_reason: f ? f.reason : '', provider: c ? c.provider : null, fallback_reason: c ? c.fallback_reason || null : null,
        generated_time: c ? new Date(c.created_ts).toISOString() : null, current: !!c, summary_id: c ? c.id : null };
    });
    const ext = externalOf();
    res.json({ summaries: rows, usage: usageToday(), settings: settings(), external_provider: ext ? { name: ext.name, label: ext.label } : null });
  });
  const setHidden = (action) => (req, res) => {
    const b = check(req.body, REASON, { unknown: 'reject', maxKeys: 1 }); const reason = reasonOf(b);
    const t = String(req.params.ticker).toUpperCase();
    if (!getEvent(t)) throw E.notFound();
    const before = flagOf(t) || null;
    const hidden = action === 'hide' ? 1 : 0;
    db.prepare('INSERT INTO ai_summary_flags(event_ticker,hidden,reason,updated_by,updated_ts) VALUES(?,?,?,?,?) ON CONFLICT(event_ticker) DO UPDATE SET hidden=excluded.hidden, reason=excluded.reason, updated_by=excluded.updated_by, updated_ts=excluded.updated_ts').run(t, hidden, reason, req.auth.user.id, Date.now());
    audit(req, `ai_summary.${action}`, t, before, flagOf(t), reason);
    emit(t, 'ai_summary');
    res.json({ event_ticker: t, hidden: !!hidden });
  };
  v1.post(`${A}/:ticker/hide`, admin.can('content.write'), setHidden('hide'));
  v1.post(`${A}/:ticker/unhide`, admin.can('content.write'), setHidden('unhide'));
  v1.post(`${A}/:ticker/regenerate`, admin.can('content.write'), async (req, res) => {
    const b = check(req.body, REASON, { unknown: 'reject', maxKeys: 1 }); const reason = reasonOf(b);
    const t = String(req.params.ticker).toUpperCase();
    if (!getEvent(t)) throw E.notFound();
    regenLimit.hit(`u:${req.auth.user.id}`);
    const items = itemsOf(t);
    if (!items.length) throw E.conflict('no_news', 'this event has no active news items');
    const hash = hashOf(items); const before = cached(t, hash);
    const row = await generate(t, items, hash, 'admin');
    audit(req, 'ai_summary.regenerate', t, before ? { id: before.id, provider: before.provider, created_ts: before.created_ts } : null, { id: row.id, provider: row.provider, fallback_reason: row.fallback_reason, created_ts: row.created_ts }, reason);
    emit(t, 'ai_summary');
    res.json({ event_ticker: t, summary: vo(row, items) });
  });
  v1.get(`${A}/settings`, admin.can('settings.write'), (req, res) => res.json({ settings: settings(), usage: usageToday() }));
  v1.put(`${A}/settings`, admin.can('settings.write'), (req, res) => {
    const b = check(req.body, SETTINGS_SCHEMA, { unknown: 'reject', maxKeys: 12 }); const reason = reasonOf(b);
    const before = settings(); const next = { ...before };
    for (const k of Object.keys(DEFAULTS)) if (b[k] !== undefined) next[k] = k === 'blocklist' ? b[k].map((x) => x.trim()).filter(Boolean) : b[k];
    saveSettings(next, req.auth.user.id);
    auditChain.append(db, { actor_id: req.auth.user.id, actor_email: req.auth.user.email, action: 'ai_summary.settings', target_type: 'settings', target_id: 'ai_summary', before, after: next, reason });
    res.json({ settings: next });
  });

  return { summaryFor, settings, hasExternal: () => !!externalOf() };
}

module.exports = { mountAiSummary, DEFAULTS };

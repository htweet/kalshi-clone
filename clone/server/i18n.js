'use strict';
// Languages (PLAN P8.4, CLONE_SPEC.md §38.5) on the CMS text catalog (§32.3). Flag `i18n`.
//
//   locales      data (table i18n_locales): code, English and native name, text direction (ltr / rtl), enabled, reviewed.
//                Seeded: en-NG (the default, always on) and Nigerian Pidgin (pcm), Hausa (ha), Yoruba (yo) and Igbo (ig),
//                ALL OFF and not reviewed (owner decision 2026-11-08: no machine-written translation ships as if it were
//                reviewed). An admin adds more locales as data (an RTL one included).
//   translations CMS text entries of the locale (cms_entries.locale), edited, published and rolled back like any text,
//                through the same validator and sanitiser (declared variables only, plain text refuses markup, rich text
//                is allowlisted). Missing keys fall back to the English (en-NG) text, then the code default.
//   workflow     Admin › Content › Languages: coverage % per locale (published translations / catalog keys), a per-key
//                "needs review" / "reviewed" state, "publish all drafts", "mark the language reviewed" (content.publish, a
//                reason, audited), and the per-locale switch (content.publish, reason, step-up, audited) which refuses
//                unless the language is reviewed and its coverage reaches the owner setting `i18n.min_coverage_pct`
//                (95 %). Export (JSON with the English default per key) and import (dry run, then apply) for translators.
//   samples      a handful of seeded sample strings per locale, published and flagged "needs review" with a note that
//                they are machine-written: they exist to exercise the workflow and never reach a visitor while the
//                locale is off.
//   choice       a member's language: their account setting (`locale`), else the guest cookie `plx_locale`, else en-NG;
//                only enabled locales count, and only while the `i18n` flag is on. No automatic switch from the browser's
//                Accept-Language (design choice: Nigeria first, English is the shared language; members choose).
//   formatting   numbers, dates and plurals per locale on the client (Intl, public/js/locale.js); money stays the display
//                currency's format (en-NG, §30).
const { ApiError, E, nowIso } = require('./util');
const { tx } = require('./db');
const texts = require('./cms/texts');
const { check } = require('./validate');
const { s: GS } = require('./content/growth');

const DEFAULT = 'en-NG';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS i18n_locales (code TEXT PRIMARY KEY, name TEXT NOT NULL, native_name TEXT NOT NULL, dir TEXT NOT NULL DEFAULT 'ltr', enabled INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0, reviewed_by TEXT, reviewed_ts INTEGER, is_default INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 100, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS i18n_text_review (locale TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_ts INTEGER NOT NULL, PRIMARY KEY (locale, key));
`;
// Seed: the default plus the four Nigerian languages of PLAN P8.4, all off. Names of languages are facts.
const SEED = [
  [DEFAULT, 'English (Nigeria)', 'English', 'ltr', 1, 1, 1, 0],
  ['pcm', 'Nigerian Pidgin', 'Naijá', 'ltr', 0, 0, 0, 10],
  ['ha', 'Hausa', 'Hausa', 'ltr', 0, 0, 0, 20],
  ['yo', 'Yoruba', 'Yorùbá', 'ltr', 0, 0, 0, 30],
  ['ig', 'Igbo', 'Igbo', 'ltr', 0, 0, 0, 40],
];
// Sample strings for the workflow only (machine-written, flagged "needs review", never shown while the locale is off).
const SAMPLES = {
  pcm: { 'shell.html.nav_markets': 'Market dem', 'shell.render_account.log_in': 'Enter', 'shell.render_account.sign_up': 'Join' },
  ha: { 'shell.html.nav_markets': 'Kasuwanni', 'shell.render_account.log_in': 'Shiga', 'shell.render_account.sign_up': 'Yi rajista' },
  yo: { 'shell.html.nav_markets': 'Àwọn ọjà', 'shell.render_account.log_in': 'Wọlé', 'shell.render_account.sign_up': 'Forúkọsílẹ̀' },
  ig: { 'shell.html.nav_markets': 'Ahịa', 'shell.render_account.log_in': 'Banye', 'shell.render_account.sign_up': 'Debanye aha' },
};
const SAMPLE_NOTE = 'Seeded sample (machine-written, not reviewed): replace or confirm with a human translator.';
const CODE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const COOKIE = 'plx_locale';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function mountI18n({ v1, app, db, engine, auth, admin, flags, cms }) {
  db.exec(SCHEMA);
  const now = Date.now();
  const ins = db.prepare('INSERT INTO i18n_locales(code,name,native_name,dir,enabled,reviewed,is_default,position,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING');
  const seeded = !!db.prepare("SELECT 1 FROM meta WHERE key='i18n_seed_v1'").get();
  if (!seeded) {
    tx(db, () => {
      for (const s of SEED) ins.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], now, now);
      // Sample strings: published entries of the (off) locale, each flagged "needs review".
      for (const [loc, strings] of Object.entries(SAMPLES)) {
        for (const [key, value] of Object.entries(strings)) {
          if (!texts.load().has(key)) continue;
          db.prepare('INSERT INTO cms_entries(type,key,locale,published_json,published_version,published_by,published_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(type,key,locale) DO NOTHING').run('text', key, loc, JSON.stringify(value), 'seed', nowIso());
          db.prepare("INSERT INTO cms_versions(type,key,locale,version,value_json,action,author_id,author_email,reason,created_at) VALUES('text',?,?,1,?,'seed',NULL,'seed',?,?)").run(key, loc, JSON.stringify(value), SAMPLE_NOTE, nowIso());
          db.prepare("INSERT INTO i18n_text_review(locale,key,status,note,updated_by,updated_ts) VALUES(?,?,'needs_review',?,NULL,?) ON CONFLICT DO NOTHING").run(loc, key, SAMPLE_NOTE, now);
        }
      }
      db.prepare("INSERT INTO meta(key,value) VALUES('i18n_seed_v1',?) ON CONFLICT(key) DO NOTHING").run(nowIso());
    });
  }
  const row = (code) => db.prepare('SELECT * FROM i18n_locales WHERE code=?').get(String(code || ''));
  const enabledCodes = () => db.prepare('SELECT code FROM i18n_locales WHERE enabled=1 ORDER BY position, code').all().map((r) => r.code);
  const isOn = (code) => code === DEFAULT || (!!flags.jobOn('i18n') && !!row(code)?.enabled);
  const publicLocale = (code) => (code && isOn(String(code)) ? String(code) : DEFAULT);
  const userLocale = (uid) => { try { const r = db.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='locale'").get(uid); return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const localeOfUser = (uid) => publicLocale(uid ? userLocale(uid) : null);
  // The request's language: the account setting, else the guest cookie; only enabled locales, only with the flag on.
  const localeOf = (req) => {
    // ?lang=<code> (the hreflang URLs of server-rendered pages) wins for that request, when the language is on.
    const q = req && req.query && typeof req.query.lang === 'string' ? req.query.lang : null;
    if (q && isOn(q)) return q;
    if (req && req.auth) { const l = userLocale(req.auth.user.id); if (l) return publicLocale(l); }
    return publicLocale(parseCookies(req && req.headers && req.headers.cookie)[COOKIE]);
  };
  const dirOf = (code) => (row(code)?.dir === 'rtl' ? 'rtl' : 'ltr');
  cms.hooks.publicLocale = publicLocale;
  cms.hooks.dirOf = dirOf;
  cms.hooks.langOf = (code) => String(code || DEFAULT);
  // The page template: <html lang dir> and the content bundle of the request's language.
  if (app) {
    const prev = app.locals.pageTransform;
    app.locals.pageTransform = (html, req, res) => {
      let out = prev ? prev(html, req, res) : html;
      const loc = localeOf(req);
      out = out.replace(/<html lang="[^"]*"[^>]*>/, `<html lang="${loc}" dir="${dirOf(loc)}">`);
      if (loc !== DEFAULT) out = out.replace('src="/content-bundle.js"', `src="/content-bundle.js?locale=${encodeURIComponent(loc)}"`);
      res.locals.locale = loc;
      return out;
    };
  }

  // ---------------------------------------------------------------- coverage
  const catalogKeys = () => [...texts.load().keys()];
  function coverage(code) {
    const total = catalogKeys().length;
    if (code === DEFAULT) return { total, translated: total, percent: 100, needs_review: 0, drafts: 0 };
    const keys = new Set(catalogKeys());
    const pub = db.prepare("SELECT key FROM cms_entries WHERE type='text' AND locale=? AND published_json IS NOT NULL").all(code).filter((r) => keys.has(r.key)).length;
    const drafts = db.prepare("SELECT COUNT(*) c FROM cms_entries WHERE type='text' AND locale=? AND draft_json IS NOT NULL").get(code).c;
    const nr = db.prepare("SELECT COUNT(*) c FROM i18n_text_review WHERE locale=? AND status='needs_review'").get(code).c;
    return { total, translated: pub, percent: total ? Math.floor((pub * 1000) / total) / 10 : 0, needs_review: nr, drafts };
  }
  const localeVo = (r) => ({ code: r.code, name: r.name, native_name: r.native_name, dir: r.dir, enabled: !!r.enabled, effective: isOn(r.code), reviewed: !!r.reviewed, reviewed_by: r.reviewed_by, reviewed_time: r.reviewed_ts ? new Date(r.reviewed_ts).toISOString() : null, is_default: !!r.is_default, position: r.position });
  const all = () => db.prepare('SELECT * FROM i18n_locales ORDER BY position, code').all();

  // ---------------------------------------------------------------- public + member
  v1.get('/i18n/locales', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const on = flags.on('i18n', { req });
    res.json({ enabled: on, default: DEFAULT, current: localeOf(req), cookie: COOKIE, locales: (on ? all().filter((r) => isOn(r.code)) : all().filter((r) => r.code === DEFAULT)).map((r) => ({ code: r.code, name: r.name, native_name: r.native_name, dir: r.dir })) });
  });
  const requireOwner = (req, res, next) => { if (!req.auth) return next(E.unauthorized()); if (req.params.uid !== req.auth.user.id) return next(E.forbidden('cannot access another user')); next(); };
  v1.put('/users/:uid/locale', requireOwner, (req, res) => {
    const b = check(req.body || {}, { locale: { type: 'string', maxLen: 12, required: true } }, { unknown: 'reject' });
    if (!row(b.locale)) throw new ApiError(400, 'unknown_locale', GS('i18n.error.unknown_locale'));
    if (!isOn(b.locale)) throw new ApiError(409, 'locale_off', GS('i18n.error.locale_off'));
    db.prepare("INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'locale',?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(req.auth.user.id, JSON.stringify(b.locale), nowIso());
    res.json({ locale: b.locale, dir: dirOf(b.locale) });
  });

  // ---------------------------------------------------------------- admin (Admin › Content › Languages)
  const can = admin.can;
  const reasonOf = (b) => { const r = String((b && b.reason) || '').trim(); if (r.length < 3 || r.length > 500) throw new ApiError(400, 'validation_failed', 'validation failed', 'reason: a reason of 3-500 characters is required'); return r; };
  const changed = () => { cms.invalidate(); try { engine.emit('content', { changed: [{ type: 'locale' }] }); } catch { /* best effort */ } flags.changed(['i18n:locales']); };
  v1.get('/admin/i18n/locales', can('content.write'), (req, res) => res.json({ locales: all().map((r) => ({ ...localeVo(r), coverage: coverage(r.code) })), min_coverage_pct: engine.ownerSettings.get('i18n.min_coverage_pct'), flag_on: flags.jobOn('i18n'), default: DEFAULT }));
  v1.post('/admin/i18n/locales', can('content.publish'), (req, res) => {
    const b = check(req.body || {}, { code: { type: 'string', maxLen: 12, required: true }, name: { type: 'string', maxLen: 60, required: true }, native_name: { type: 'string', maxLen: 60, required: true }, dir: { type: 'string', enum: ['ltr', 'rtl'] }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    if (!CODE_RE.test(b.code)) throw new ApiError(400, 'validation_failed', 'validation failed', `code: ${GS('i18n.error.code')}`);
    if (row(b.code)) throw E.conflict('locale_exists', GS('i18n.error.exists'));
    for (const f of ['name', 'native_name']) if (!b[f].trim() || /[<>\u0000-\u001f]/.test(b[f])) throw new ApiError(400, 'validation_failed', 'validation failed', `${f}: plain text, 1-60 characters`);
    const t = Date.now();
    db.prepare('INSERT INTO i18n_locales(code,name,native_name,dir,enabled,reviewed,is_default,position,created_ts,updated_ts) VALUES(?,?,?,?,0,0,0,?,?,?)').run(b.code, b.name.trim(), b.native_name.trim(), b.dir || 'ltr', 200, t, t);
    admin.audit(req, 'i18n.locale.create', 'locale', b.code, null, localeVo(row(b.code)), reason);
    changed();
    res.status(201).json({ locale: { ...localeVo(row(b.code)), coverage: coverage(b.code) } });
  });
  v1.put('/admin/i18n/locales/:code', can('content.publish'), (req, res) => {
    const code = String(req.params.code);
    const cur = row(code);
    if (!cur) throw E.notFound();
    const b = check(req.body || {}, { enabled: { type: 'boolean' }, reviewed: { type: 'boolean' }, name: { type: 'string', maxLen: 60 }, native_name: { type: 'string', maxLen: 60 }, dir: { type: 'string', enum: ['ltr', 'rtl'] }, reason: { type: 'string', maxLen: 500, required: true } }, { unknown: 'reject' });
    const reason = reasonOf(b);
    const next = {};
    if (b.name !== undefined) next.name = b.name.trim();
    if (b.native_name !== undefined) next.native_name = b.native_name.trim();
    for (const f of ['name', 'native_name']) if (next[f] !== undefined && (!next[f] || /[<>\u0000-\u001f]/.test(next[f]))) throw new ApiError(400, 'validation_failed', 'validation failed', `${f}: plain text, 1-60 characters`);
    if (b.dir !== undefined) next.dir = b.dir;
    if (b.reviewed !== undefined) Object.assign(next, { reviewed: b.reviewed ? 1 : 0, reviewed_by: b.reviewed ? req.auth.user.email : null, reviewed_ts: b.reviewed ? Date.now() : null });
    if (b.enabled !== undefined) {
      if (cur.is_default && !b.enabled) throw E.conflict('default_locale', GS('i18n.error.default_locale'));
      if (b.enabled && !cur.is_default) {
        const reviewed = next.reviewed !== undefined ? next.reviewed : cur.reviewed;
        if (!reviewed) throw E.conflict('locale_not_reviewed', GS('i18n.error.not_reviewed'));
        const cov = coverage(code); const min = engine.ownerSettings.get('i18n.min_coverage_pct');
        if (cov.percent < min) throw E.conflict('locale_coverage', GS('i18n.error.coverage', { coverage: cov.percent, min }));
      }
      auth.assertFresh(req, 'locale_switch'); // what every visitor reads: a fresh step-up
      next.enabled = b.enabled ? 1 : 0;
    }
    if (!Object.keys(next).length) throw new ApiError(400, 'validation_failed', 'validation failed', 'body: nothing to change');
    const cols = Object.keys(next);
    db.prepare(`UPDATE i18n_locales SET ${cols.map((c) => `${c}=?`).join(', ')}, updated_ts=? WHERE code=?`).run(...cols.map((c) => next[c]), Date.now(), code);
    admin.audit(req, b.enabled !== undefined ? 'i18n.locale.switch' : 'i18n.locale.update', 'locale', code, localeVo(cur), localeVo(row(code)), reason);
    changed();
    res.json({ locale: { ...localeVo(row(code)), coverage: coverage(code) } });
  });
  // Translation list of a locale: key, English default (published en-NG override or code default), translation, review state.
  v1.get('/admin/i18n/locales/:code/texts', can('content.write'), (req, res) => {
    const code = String(req.params.code);
    if (!row(code) || code === DEFAULT) throw E.notFound();
    const cat = texts.load();
    const en = cms.store.published('text');
    const tr = new Map(db.prepare("SELECT key, published_json, draft_json FROM cms_entries WHERE type='text' AND locale=?").all(code).map((r) => [r.key, r]));
    const rv = new Map(db.prepare('SELECT * FROM i18n_text_review WHERE locale=?').all(code).map((r) => [r.key, r]));
    const q = String(req.query.q || '').toLowerCase().slice(0, 100);
    const state = String(req.query.state || '');
    let items = [];
    for (const e of cat.values()) {
      const t = tr.get(e.key); const r = rv.get(e.key);
      const pub = t && t.published_json != null ? JSON.parse(t.published_json) : null;
      const draft = t && t.draft_json != null ? JSON.parse(t.draft_json) : null;
      const english = en.has(e.key) ? en.get(e.key) : e.default;
      if (state === 'missing' && pub != null) continue;
      if (state === 'translated' && pub == null) continue;
      if (state === 'needs_review' && !(r && r.status === 'needs_review')) continue;
      if (state === 'draft' && draft == null) continue;
      if (q && !e.key.toLowerCase().includes(q) && !String(english).toLowerCase().includes(q) && !String(pub ?? '').toLowerCase().includes(q)) continue;
      items.push({ key: e.key, area: e.area, english, vars: e.vars, rich: e.rich, translation: pub, draft, review: r ? r.status : pub != null ? 'unreviewed' : null, note: r ? r.note : '' });
    }
    const total = items.length;
    const offset = Math.max(0, Number(req.query.offset) || 0); const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    items = items.slice(offset, offset + limit);
    res.json({ locale: { ...localeVo(row(code)), coverage: coverage(code) }, total, offset, limit, items });
  });
  // Review state of one translated key (content.publish): reviewed / needs_review.
  v1.put('/admin/i18n/locales/:code/review', can('content.publish'), (req, res) => {
    const code = String(req.params.code);
    if (!row(code) || code === DEFAULT) throw E.notFound();
    const b = check(req.body || {}, { key: { type: 'string', maxLen: 200, required: true }, status: { type: 'string', enum: ['reviewed', 'needs_review'], required: true }, note: { type: 'string', maxLen: 300 } }, { unknown: 'reject' });
    if (!texts.load().has(b.key)) throw E.notFound();
    db.prepare('INSERT INTO i18n_text_review(locale,key,status,note,updated_by,updated_ts) VALUES(?,?,?,?,?,?) ON CONFLICT(locale,key) DO UPDATE SET status=excluded.status, note=excluded.note, updated_by=excluded.updated_by, updated_ts=excluded.updated_ts')
      .run(code, b.key, b.status, String(b.note || '').replace(/[<>\u0000-\u001f]/g, ''), req.auth.user.email, Date.now());
    admin.audit(req, 'i18n.text.review', 'cms.text', `${b.key}@${code}`, null, { status: b.status }, b.note || '');
    res.json({ key: b.key, status: b.status, coverage: coverage(code) });
  });
  // Publish every draft of a locale at once (content.publish, a reason): one version + audit row per entry.
  v1.post('/admin/i18n/locales/:code/publish_drafts', can('content.publish'), (req, res) => {
    const code = String(req.params.code);
    if (!row(code)) throw E.notFound();
    const reason = reasonOf(req.body || {});
    const keys = db.prepare("SELECT key FROM cms_entries WHERE type='text' AND locale=? AND draft_json IS NOT NULL").all(code).map((r) => r.key);
    let n = 0;
    for (const k of keys) { cms.store.publish(req, 'text', k, { reason, locale: code }); n += 1; }
    changed();
    res.json({ published: n, coverage: coverage(code) });
  });
  // Translator export / import (JSON). Import validates every entry like the editor; a dry run changes nothing; applying
  // (content.publish, a reason) publishes the translations and marks them "needs review" until a reviewer confirms them.
  v1.get('/admin/i18n/locales/:code/export', can('content.write'), (req, res) => {
    const code = String(req.params.code);
    if (!row(code) || code === DEFAULT) throw E.notFound();
    const cat = texts.load(); const en = cms.store.published('text'); const tr = cms.store.published('text', code);
    res.setHeader('Content-Disposition', `attachment; filename="parlance-${code}-${nowIso().slice(0, 10)}.json"`);
    res.json({ format: 'parlance-translations', version: 1, locale: code, exported_at: nowIso(), entries: [...cat.values()].map((e) => ({ key: e.key, english: en.has(e.key) ? en.get(e.key) : e.default, vars: e.vars, rich: e.rich, translation: tr.has(e.key) ? tr.get(e.key) : null })) });
  });
  v1.post('/admin/i18n/locales/:code/import', can('content.write'), (req, res) => {
    const code = String(req.params.code);
    if (!row(code) || code === DEFAULT) throw E.notFound();
    const b = check(req.body || {}, { data: { type: 'object', required: true }, dry_run: { type: 'boolean' }, reason: { type: 'string', maxLen: 500 } }, { unknown: 'reject' });
    const dry = b.dry_run !== false;
    if (!dry && !admin.rolesOf(req.auth.user).some((r) => r === 'admin' || r === 'publisher')) throw new ApiError(403, 'forbidden', 'forbidden', 'your role does not include content.publish');
    const d = b.data;
    if (d.format !== 'parlance-translations' || d.locale !== code || !Array.isArray(d.entries) || d.entries.length > 20000) throw new ApiError(400, 'validation_failed', 'validation failed', 'data: a parlance-translations file for this locale');
    const errors = []; const plan = [];
    const cur = cms.store.published('text', code);
    for (const e of d.entries) {
      if (!e || typeof e.key !== 'string' || e.translation == null || e.translation === '') continue;
      try {
        const v = texts.validate(e.key, e.translation);
        if (cur.get(e.key) !== v) plan.push({ key: e.key, before: cur.has(e.key) ? cur.get(e.key) : null, after: v });
      } catch (x) { errors.push({ key: String(e.key).slice(0, 200), error: x && typeof x === 'object' ? Object.values(x).filter((y) => typeof y === 'string').join('; ') || 'invalid' : String(x) }); }
    }
    if (errors.length) return res.status(400).json({ valid: false, errors: errors.slice(0, 200), error: { code: 'validation_failed', message: 'the file has invalid entries' } });
    if (dry) return res.json({ valid: true, dry_run: true, changes: plan.length, diff: plan.slice(0, 500) });
    const reason = reasonOf(b);
    tx(db, () => {
      for (const p of plan) {
        cms.store.publish(req, 'text', p.key, { reason, locale: code, value: p.after });
        db.prepare("INSERT INTO i18n_text_review(locale,key,status,note,updated_by,updated_ts) VALUES(?,?,'needs_review','imported',?,?) ON CONFLICT(locale,key) DO UPDATE SET status='needs_review', note='imported', updated_by=excluded.updated_by, updated_ts=excluded.updated_ts").run(code, p.key, req.auth.user.email, Date.now());
      }
    });
    changed();
    res.json({ valid: true, dry_run: false, changes: plan.length, coverage: coverage(code) });
  });

  return { localeOf, localeOfUser, publicLocale, enabledCodes, isOn, dirOf, coverage, all, DEFAULT, COOKIE };
}

module.exports = { mountI18n, DEFAULT, SEED, SAMPLES };

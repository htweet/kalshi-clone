'use strict';
// "What's on your ballot?" (Phase 5B, PLAN P5.3; CLONE_SPEC.md §29.5). Maps an address or ZIP-like code to invented
// jurisdictions (server/civic-data.js) and lists the contests that have markets on Parlance.
//
// Privacy (design rule, tested): the raw address is used only in memory to resolve a jurisdiction and is never written
// to the database, a log or the audit trail. The lookup is a POST so the address never appears in a URL or access log.
// If a signed-in user chooses to save the result, only the resolved jurisdiction id is stored (ballot_saved). Lookups
// are rate limited per user / per IP (hashed keys, server/content-rate.js).
const { tx } = require('./db');
const { nowIso, E } = require('./util');
const { check } = require('./validate');
const { PLACES } = require('./civic-data');
const { createLimiter } = require('./content-rate');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ballot_jurisdictions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT, zip_ranges TEXT NOT NULL DEFAULT '[]', names TEXT NOT NULL DEFAULT '[]', contests TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS ballot_saved (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, jurisdiction_id TEXT NOT NULL, saved_at TEXT NOT NULL);
`;
const LOOKUP = { address: { type: 'string', maxLen: 200, required: true } };
const SAVE = { jurisdiction_id: { type: 'string', maxLen: 16, pattern: /^[A-Z]{2}(-[A-Z0-9]{1,4})?$/, required: true } };
const KIND_RANK = { city: 3, district: 2, state: 1 };

function mountBallot({ v1, db, engine, requireUser, eventFull, getEvent, security, options = {} }) {
  db.exec(SCHEMA);
  // Reference data: upserted from code on every start (invented, static).
  tx(db, () => {
    for (const p of PLACES) {
      db.prepare('INSERT INTO ballot_jurisdictions(id,kind,name,parent_id,zip_ranges,names,contests) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, parent_id=excluded.parent_id, zip_ranges=excluded.zip_ranges, names=excluded.names, contests=excluded.contests')
        .run(p.id, p.kind, p.name, p.parent, JSON.stringify(p.zips), JSON.stringify(p.names), JSON.stringify(p.contests));
    }
  });
  const places = () => db.prepare('SELECT * FROM ballot_jurisdictions').all().map((r) => ({ ...r, zips: JSON.parse(r.zip_ranges), names: JSON.parse(r.names), contests: JSON.parse(r.contests) }));
  const userLimit = createLimiter(db, 'ballot_user', { limit: options.ballotPerMinute ?? 20, windowMs: 60000 });
  const ipLimit = createLimiter(db, 'ballot_ip', { limit: options.ballotPerIpMinute ?? 120, windowMs: 60000 });

  const inRange = (zip, r) => { const [a, b] = r.split('-').map(Number); const z = Number(zip); return z >= a && z <= (b || a); };
  // Resolve without keeping the input: returns {place, matched_by} or null.
  function resolve(address) {
    const text = String(address).normalize('NFKC').toLowerCase();
    const all = places();
    const zip = /(?:^|\D)(\d{5})(?:\D|$)/.exec(text)?.[1];
    let hit = null; let by = null;
    if (zip) {
      hit = all.filter((p) => p.zips.some((r) => inRange(zip, r))).sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind])[0] || null;
      by = hit ? 'zip' : null;
    }
    if (!hit) {
      const words = ` ${text.replace(/[^a-z0-9]+/g, ' ')} `;
      hit = all.filter((p) => p.names.some((n) => words.includes(` ${n.toLowerCase()} `))).sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind])[0] || null;
      by = hit ? 'name' : null;
    }
    return hit ? { place: hit, matched_by: by } : null;
  }
  const chainOf = (place) => {
    const byId = new Map(places().map((p) => [p.id, p]));
    const out = []; let p = place; let guard = 0;
    while (p && guard++ < 6) { out.unshift(p); p = p.parent_id ? byId.get(p.parent_id) : null; }
    return out;
  };
  const lead = (ev) => ev.markets.reduce((a, m) => (Number(m.last_price_dollars || 0) > Number(a.last_price_dollars || 0) ? m : a), ev.markets[0]);
  function contestsOf(chain) {
    const out = [];
    for (const p of chain) {
      for (const c of p.contests) {
        const e = getEvent(c.event);
        if (!e) continue;
        const ev = eventFull(e);
        if (!ev.markets.some((m) => m.status === 'active')) continue;
        const L = lead(ev);
        out.push({ event_ticker: ev.event_ticker, series_ticker: ev.series_ticker, series_slug: ev.series_slug, title: ev.title, office: c.office, kind: c.kind, level: p.kind, jurisdiction: p.name,
          markets: ev.markets.map((m) => ({ ticker: m.ticker, name: m.yes_sub_title, last_price_dollars: m.last_price_dollars, yes_ask_dollars: m.yes_ask_dollars, color: m.color })),
          leader: L ? { ticker: L.ticker, name: L.yes_sub_title, last_price_dollars: L.last_price_dollars } : null });
      }
    }
    return out;
  }
  const jurisdictionVo = (chain) => { const p = chain[chain.length - 1]; return { id: p.id, kind: p.kind, name: p.name, chain: chain.map((x) => ({ id: x.id, kind: x.kind, name: x.name })) }; };
  const result = (place) => { const chain = chainOf(place); return { jurisdiction: jurisdictionVo(chain), contests: contestsOf(chain) }; };
  const placeById = (id) => places().find((p) => p.id === id) || null;

  v1.post('/ballot/lookup', (req, res) => {
    const b = check(req.body, LOOKUP, { unknown: 'reject', maxKeys: 2 });
    ipLimit.hit(`ip:${security ? security.clientIp(req) : req.ip}`);
    if (req.auth) userLimit.hit(`u:${req.auth.user.id}`);
    const address = b.address.trim();
    if (address.length < 3) throw E.badRequest('enter an address or a 5-digit code');
    const r = resolve(address);
    if (!r) return res.json({ jurisdiction: null, contests: [], matched_by: null });
    res.json({ ...result(r.place), matched_by: r.matched_by });
  });
  v1.get('/ballot/jurisdictions/:id', (req, res) => {
    const p = placeById(String(req.params.id).toUpperCase());
    if (!p) throw E.notFound();
    res.json(result(p));
  });
  v1.get('/users/:uid/ballot', requireUser, (req, res) => {
    const s = db.prepare('SELECT * FROM ballot_saved WHERE user_id=?').get(req.auth.user.id);
    const p = s && placeById(s.jurisdiction_id);
    res.json(p ? { saved: { jurisdiction_id: s.jurisdiction_id, saved_at: s.saved_at }, ...result(p) } : { saved: null, jurisdiction: null, contests: [] });
  });
  v1.put('/users/:uid/ballot', requireUser, (req, res) => {
    const b = check(req.body, SAVE, { unknown: 'reject', maxKeys: 1 });
    const p = placeById(b.jurisdiction_id);
    if (!p) throw E.badRequest('unknown jurisdiction');
    const at = nowIso();
    db.prepare('INSERT INTO ballot_saved(user_id,jurisdiction_id,saved_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET jurisdiction_id=excluded.jurisdiction_id, saved_at=excluded.saved_at').run(req.auth.user.id, p.id, at);
    res.json({ saved: { jurisdiction_id: p.id, saved_at: at }, ...result(p) });
  });
  v1.delete('/users/:uid/ballot', requireUser, (req, res) => {
    db.prepare('DELETE FROM ballot_saved WHERE user_id=?').run(req.auth.user.id);
    res.json({ ok: true });
  });
  void engine;
  return { resolve: (a) => { const r = resolve(a); return r ? r.place.id : null; } };
}

module.exports = { mountBallot };

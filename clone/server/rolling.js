'use strict';
// Rolling short-window "Above / Below target" markets (spec §15.6; observed on the live site as "BTC 15 MIN",
// "GOLD 15 MIN" cards with a target price, distance from target and Above/Below odds).
// Parlance runs one invented underlying, the PLX token, with a simulated price persisted in SQLite.
const CS = require('./content/currency-strings'); // keyed user-facing wording (CLONE_SPEC.md §30)
const C = require('./currency'); // display currency formatting (CLONE_SPEC.md §30)
const { nowIso, newId, dollars, E } = require('./util');

const SERIES = 'PLXFLASH';
const { marketVo } = require('./serialize');
// Extra invented underlyings (owner request 2026-11-15, the member home's 15 Min Markets; CLONE_SPEC.md §41.3), switched by
// the owner setting `rolling.extra_underlyings`. Their prices live in flash_prices_x (migration 0006), one point per 5 s,
// kept 2 hours; the PLX token keeps flash_prices. Series tickers start with PLXFLASH, so every discovery list that leaves
// the rolling markets out (`LIKE 'PLXFLASH%'`) leaves these out too; `PLXFLASH-%` is still the PLX token alone.
const EXTRAS = [
  { key: 'ORB', series: 'PLXFLASHORB', slug: 'orb-token-price', name: 'ORB token', start: 3240, step: 9, min: 1500, max: 6000, color: '#7048e8' },
  { key: 'KOLA', series: 'PLXFLASHKOLA', slug: 'kola-token-price', name: 'KOLA token', start: 912, step: 3, min: 400, max: 1800, color: '#e8590c' },
  { key: 'H100', series: 'PLXFLASHHX', slug: 'harbor-100-price', name: 'Harbor 100 index', start: 6480, step: 8, min: 3000, max: 12000, color: '#1c7ed6' },
];
const extraOf = (eventTicker) => EXTRAS.find((x) => String(eventTicker).startsWith(`${x.series}-`)) || null;
const iso = (ms) => new Date(ms).toISOString();
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(2, 15); // yyMMddTHHmmss

function mountRolling({ v1, db, engine, windowSec = 900 }) {
  // Window length is editable at runtime (Admin › Settings, gap G7): windows already open keep their stored end time; the
  // next window opens on the new grid.
  let W; let label;
  function setWindowSec(sec) {
    W = Math.max(5, Number(sec) || 900) * 1000;
    label = W % 60000 === 0 ? `${W / 60000} min` : `${W / 1000} sec`;
    return W / 1000;
  }
  setWindowSec(windowSec);
  db.exec('CREATE TABLE IF NOT EXISTS flash_prices (ts INTEGER PRIMARY KEY, price_cents INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS flash_windows (event_ticker TEXT PRIMARY KEY, market_ticker TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, target_cents INTEGER NOT NULL, close_cents INTEGER, result TEXT)');
  if (!db.prepare('SELECT 1 FROM series WHERE ticker=?').get(SERIES)) {
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(SERIES, `PLX token ${label}`, 'plx-token-price', 'Crypto', JSON.stringify(['15 min', 'Prices']), 'fifteen_min', 'quadratic', 1,
        JSON.stringify([{ name: 'Parlance PLX index', url: 'https://example.org/plx-index' }]),
        'Each window resolves YES ("Above") if the PLX index at the window close is above the target, which is the index level at the window open. Otherwise it resolves NO ("Below").');
  }
  for (const x of EXTRAS) {
    if (db.prepare('SELECT 1 FROM series WHERE ticker=?').get(x.series)) continue;
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(x.series, `${x.name} ${label}`, x.slug, 'Crypto', JSON.stringify(['15 min', 'Prices']), 'fifteen_min', 'quadratic', 1,
        JSON.stringify([{ name: `Parlance ${x.key} index`, url: 'https://example.org/plx-index' }]), CS.t('rolling.x.series_rules', { name: x.name }));
  }
  const extrasOn = () => (engine.ownerSettings ? engine.ownerSettings.get('rolling.extra_underlyings') !== false : true);
  const hasX = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='flash_prices_x'").get();
  const lastX = (x) => db.prepare('SELECT price_cents p FROM flash_prices_x WHERE underlying=? ORDER BY ts DESC LIMIT 1').get(x.key)?.p ?? x.start;
  const priceAtX = (x, ms) => db.prepare('SELECT price_cents p FROM flash_prices_x WHERE underlying=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(x.key, ms)?.p ?? lastX(x);
  let lastXTs = 0;
  function stepExtras(now) {
    if (now - lastXTs < 5000 || !hasX()) return;
    lastXTs = now;
    for (const x of EXTRAS) {
      const p = lastX(x);
      const next = Math.max(x.min, Math.min(x.max, p + Math.round((Math.random() - 0.5) * 2 * x.step)));
      db.prepare('INSERT OR REPLACE INTO flash_prices_x(underlying,ts,price_cents) VALUES(?,?,?)').run(x.key, now, next);
    }
    db.prepare('DELETE FROM flash_prices_x WHERE ts<?').run(now - 2 * 3600000);
  }
  const lp = () => db.prepare("SELECT id FROM users WHERE email='liquidity@parlance.local'").get()?.id;
  const lastPrice = () => db.prepare('SELECT price_cents p FROM flash_prices ORDER BY ts DESC LIMIT 1').get()?.p ?? 500;
  const priceAt = (ms) => db.prepare('SELECT price_cents p FROM flash_prices WHERE ts<=? ORDER BY ts DESC LIMIT 1').get(ms)?.p ?? lastPrice();

  // Bounded random walk, one point per second at most, kept for 2 days.
  let lastTs = 0;
  function stepPrice(now) {
    if (now - lastTs < 1000) return;
    lastTs = now;
    const p = lastPrice();
    const next = Math.max(100, Math.min(2000, p + Math.round((Math.random() - 0.5) * 6)));
    db.prepare('INSERT OR REPLACE INTO flash_prices(ts,price_cents) VALUES(?,?)').run(now, next);
    db.prepare('DELETE FROM flash_prices WHERE ts<?').run(now - 2 * 86400000);
  }

  function openWindow(start, x = null) {
    const et = `${x ? x.series : SERIES}-${stamp(start)}`;
    if (db.prepare('SELECT 1 FROM flash_windows WHERE event_ticker=?').get(et)) return;
    const end = start + W;
    const target = x ? priceAtX(x, start) : priceAt(start);
    const mt = `${et}-T${target}`;
    const now = nowIso();
    const hhmm = C.timeLabel(end); // configured locale + time zone, e.g. "15:15 WAT" (CLONE_SPEC.md §30)
    const money = C.moneyCents(target);
    db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(et, x ? x.series : SERIES, x ? CS.t('rolling.x.event_title', { name: x.name, target: money, time: hhmm }) : CS.t('rolling.event_title', { target: money, time: hhmm }), `${x ? x.key : 'PLX'} ${label}`, 'Crypto', 0, 1, CS.t('rolling.closes', { time: hhmm }), '', 0, now);
    db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(mt, et, x ? CS.t('rolling.x.market_title', { name: x.name, target: money }) : CS.t('rolling.market_title', { target: money }), 'Above', 'Below', x ? x.color : '#d9480f', 'active', iso(start), iso(end), iso(end + 5000), 5,
        x ? CS.t('rolling.x.rules', { name: x.name, time: hhmm, target: money }) : CS.t('rolling.rules', { time: hhmm, target: money }), now, now);
    db.prepare('INSERT INTO flash_windows(event_ticker,market_ticker,start_ts,end_ts,target_cents) VALUES(?,?,?,?,?)').run(et, mt, start, end, target);
    const id = lp();
    if (id) { // 400 contracts per side (40,000 units)
      try { engine.placeOrder(id, { ticker: mt, side: 'yes', price: 47, count: 40000, source: 'liquidity' }); engine.placeOrder(id, { ticker: mt, side: 'no', price: 47, count: 40000, source: 'liquidity' }); } catch { /* liquidity optional */ }
    }
  }

  function settleClosed(now) {
    for (const w of db.prepare('SELECT f.*, m.status FROM flash_windows f JOIN markets m ON m.ticker=f.market_ticker WHERE f.result IS NULL AND f.end_ts<=?').all(now)) {
      if (!['closed', 'active', 'inactive'].includes(w.status)) continue;
      const xx = extraOf(w.event_ticker);
      const close = xx ? (hasX() ? priceAtX(xx, w.end_ts) : w.target_cents) : priceAt(w.end_ts);
      const result = close > w.target_cents ? 'yes' : 'no';
      db.prepare('UPDATE flash_windows SET close_cents=?, result=? WHERE event_ticker=?').run(close, result, w.event_ticker);
      db.prepare('UPDATE events SET is_live=0, live_label=? WHERE ticker=?').run(`Settled ${result === 'yes' ? 'Above' : 'Below'}`, w.event_ticker);
      try { engine.determine(w.market_ticker, result); } catch { /* already determined */ }
    }
  }

  function tick() {
    const now = Date.now();
    stepPrice(now);
    const x = extrasOn() && hasX();
    if (x) stepExtras(now);
    settleClosed(now);
    openWindow(Math.floor(now / W) * W);
    if (x) for (const u of EXTRAS) openWindow(Math.floor(now / W) * W, u);
  }
  engine.on('tick', () => { if (engine.flags && !engine.flags.jobOn('trading.rolling')) return; try { tick(); } catch (e) { console.error('rolling', e); } }); // paused while the flag is off (§33)
  tick();

  const windowVo = (w) => {
    const x = extraOf(w.event_ticker);
    const cur = w.result ? w.close_cents : x ? (hasX() ? lastX(x) : w.target_cents) : lastPrice();
    return { event_ticker: w.event_ticker, market_ticker: w.market_ticker, label: `${x ? x.key : 'PLX'} ${label}`, start_time: iso(w.start_ts), end_time: iso(w.end_ts), target_dollars: dollars(w.target_cents), current_dollars: dollars(cur), distance_dollars: dollars(cur - w.target_cents), result: w.result };
  };
  // Live card data: current window, its target and the price path since the window opened. The PLX token only (the Live
  // page card); every underlying is in /rolling/windows.
  v1.get('/rolling/current', (req, res) => {
    const w = db.prepare("SELECT * FROM flash_windows WHERE event_ticker LIKE 'PLXFLASH-%' ORDER BY start_ts DESC LIMIT 1").get();
    if (!w) throw E.notFound();
    const pts = db.prepare('SELECT ts, price_cents p FROM flash_prices WHERE ts>=? ORDER BY ts').all(Math.max(w.start_ts - W, Date.now() - 2 * W));
    const step = Math.max(1, Math.ceil(pts.length / 120));
    res.json({ window: windowVo(w), prices: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((x) => ({ ts: x.ts, price_dollars: dollars(x.p) })) });
  });
  v1.get('/rolling/determined', (req, res) => {
    res.json({ windows: db.prepare("SELECT * FROM flash_windows WHERE result IS NOT NULL AND event_ticker LIKE 'PLXFLASH-%' ORDER BY end_ts DESC LIMIT 5").all().map(windowVo) });
  });
  // Every open window (the PLX token, then the extra underlyings while they run): target, distance, the price path since
  // the window opened (at most 40 points), the market's prices and volume. Bounded: one window per underlying.
  function openWindows() {
    const now = Date.now();
    const out = [];
    for (const u of [null, ...EXTRAS]) {
      const prefix = `${u ? u.series : SERIES}-%`;
      const w = db.prepare('SELECT * FROM flash_windows WHERE event_ticker LIKE ? AND result IS NULL AND end_ts>? ORDER BY start_ts DESC LIMIT 1').get(prefix, now - 1000);
      if (!w) continue;
      const m = db.prepare('SELECT * FROM markets WHERE ticker=?').get(w.market_ticker);
      if (!m || m.status !== 'active') continue;
      const pts = u ? (hasX() ? db.prepare('SELECT ts, price_cents p FROM flash_prices_x WHERE underlying=? AND ts>=? ORDER BY ts').all(u.key, w.start_ts) : [])
        : db.prepare('SELECT ts, price_cents p FROM flash_prices WHERE ts>=? ORDER BY ts').all(w.start_ts);
      const step = Math.max(1, Math.ceil(pts.length / 40));
      const mv = marketVo(m, engine.quote(m.ticker));
      out.push({ ...windowVo(w), underlying: u ? u.key : 'PLX', name: u ? u.name : 'PLX token', color: u ? u.color : '#d9480f', series_ticker: u ? u.series : SERIES, series_slug: u ? u.slug : 'plx-token-price',
        market: { ticker: mv.ticker, yes_ask_dollars: mv.yes_ask_dollars, no_ask_dollars: mv.no_ask_dollars, last_price_dollars: mv.last_price_dollars, yes_bid_dollars: mv.yes_bid_dollars, dollar_volume: mv.dollar_volume },
        prices: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((x) => [x.ts, dollars(x.p)]) });
    }
    return { windows: out, next_close_time: out.length ? out.map((w) => w.end_time).sort()[0] : null, window_seconds: W / 1000 };
  }
  v1.get('/rolling/windows', (req, res) => res.json(openWindows()));
  return { tick, setWindowSec, windowSec: () => W / 1000, openWindows };
}

module.exports = { mountRolling, SERIES, EXTRAS };

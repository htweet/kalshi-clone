'use strict';
// Rolling short-window "Above / Below target" markets (spec §15.6; observed on the live site as "BTC 15 MIN",
// "GOLD 15 MIN" cards with a target price, distance from target and Above/Below odds).
// Parlance runs one invented underlying, the PLX token, with a simulated price persisted in SQLite.
const { nowIso, newId, dollars, E } = require('./util');

const SERIES = 'PLXFLASH';
const iso = (ms) => new Date(ms).toISOString();
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(2, 15); // yyMMddTHHmmss

function mountRolling({ v1, db, engine, windowSec = 900 }) {
  const W = Math.max(5, Number(windowSec) || 900) * 1000;
  const label = W % 60000 === 0 ? `${W / 60000} min` : `${W / 1000} sec`;
  db.exec('CREATE TABLE IF NOT EXISTS flash_prices (ts INTEGER PRIMARY KEY, price_cents INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS flash_windows (event_ticker TEXT PRIMARY KEY, market_ticker TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, target_cents INTEGER NOT NULL, close_cents INTEGER, result TEXT)');
  if (!db.prepare('SELECT 1 FROM series WHERE ticker=?').get(SERIES)) {
    db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(SERIES, `PLX token ${label}`, 'plx-token-price', 'Crypto', JSON.stringify(['15 min', 'Prices']), 'fifteen_min', 'quadratic', 1,
        JSON.stringify([{ name: 'Parlance PLX index', url: 'https://example.org/plx-index' }]),
        'Each window resolves YES ("Above") if the PLX index at the window close is above the target, which is the index level at the window open. Otherwise it resolves NO ("Below").');
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

  function openWindow(start) {
    const et = `${SERIES}-${stamp(start)}`;
    if (db.prepare('SELECT 1 FROM flash_windows WHERE event_ticker=?').get(et)) return;
    const end = start + W;
    const target = priceAt(start);
    const mt = `${et}-T${target}`;
    const now = nowIso();
    const hhmm = new Date(end).toISOString().slice(11, 16);
    db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(et, SERIES, `PLX token above $${(target / 100).toFixed(2)} at ${hhmm} UTC?`, `PLX ${label}`, 'Crypto', 0, 1, `Closes ${hhmm} UTC`, '', 0, now);
    db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(mt, et, `PLX token above $${(target / 100).toFixed(2)}?`, 'Above', 'Below', '#d9480f', 'active', iso(start), iso(end), iso(end + 5000), 5,
        `Resolves YES if the PLX index at ${hhmm} UTC is above $${(target / 100).toFixed(2)}.`, now, now);
    db.prepare('INSERT INTO flash_windows(event_ticker,market_ticker,start_ts,end_ts,target_cents) VALUES(?,?,?,?,?)').run(et, mt, start, end, target);
    const id = lp();
    if (id) { // 400 contracts per side (40,000 units)
      try { engine.placeOrder(id, { ticker: mt, side: 'yes', price: 47, count: 40000, source: 'liquidity' }); engine.placeOrder(id, { ticker: mt, side: 'no', price: 47, count: 40000, source: 'liquidity' }); } catch { /* liquidity optional */ }
    }
  }

  function settleClosed(now) {
    for (const w of db.prepare('SELECT f.*, m.status FROM flash_windows f JOIN markets m ON m.ticker=f.market_ticker WHERE f.result IS NULL AND f.end_ts<=?').all(now)) {
      if (!['closed', 'active', 'inactive'].includes(w.status)) continue;
      const close = priceAt(w.end_ts);
      const result = close > w.target_cents ? 'yes' : 'no';
      db.prepare('UPDATE flash_windows SET close_cents=?, result=? WHERE event_ticker=?').run(close, result, w.event_ticker);
      db.prepare('UPDATE events SET is_live=0, live_label=? WHERE ticker=?').run(`Settled ${result === 'yes' ? 'Above' : 'Below'}`, w.event_ticker);
      try { engine.determine(w.market_ticker, result); } catch { /* already determined */ }
    }
  }

  function tick() {
    const now = Date.now();
    stepPrice(now);
    settleClosed(now);
    openWindow(Math.floor(now / W) * W);
  }
  engine.on('tick', () => { try { tick(); } catch (e) { console.error('rolling', e); } });
  tick();

  const windowVo = (w) => {
    const cur = w.result ? w.close_cents : lastPrice();
    return { event_ticker: w.event_ticker, market_ticker: w.market_ticker, label: `PLX ${label}`, start_time: iso(w.start_ts), end_time: iso(w.end_ts), target_dollars: dollars(w.target_cents), current_dollars: dollars(cur), distance_dollars: dollars(cur - w.target_cents), result: w.result };
  };
  // Live card data: current window, its target and the price path since the window opened.
  v1.get('/rolling/current', (req, res) => {
    const w = db.prepare('SELECT * FROM flash_windows ORDER BY start_ts DESC LIMIT 1').get();
    if (!w) throw E.notFound();
    const pts = db.prepare('SELECT ts, price_cents p FROM flash_prices WHERE ts>=? ORDER BY ts').all(Math.max(w.start_ts - W, Date.now() - 2 * W));
    const step = Math.max(1, Math.ceil(pts.length / 120));
    res.json({ window: windowVo(w), prices: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((x) => ({ ts: x.ts, price_dollars: dollars(x.p) })) });
  });
  v1.get('/rolling/determined', (req, res) => {
    res.json({ windows: db.prepare('SELECT * FROM flash_windows WHERE result IS NOT NULL ORDER BY end_ts DESC LIMIT 5').all().map(windowVo) });
  });
  return { tick };
}

module.exports = { mountRolling, SERIES };

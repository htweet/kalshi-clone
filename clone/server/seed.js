'use strict';
// Seed data: entirely invented content (no third-party data or assets).
const { open, tx } = require('./db');
const { nowIso, newId, hashPassword, slugify } = require('./util');

// Deterministic PRNG so seeded charts are stable across runs.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const H = 3600 * 1000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

const CATALOG = [
  { s: 'PLXCOUNCIL', title: 'Harbor City council vote', cat: 'Politics', tags: ['Local'], events: [
    { e: 'PLXCOUNCIL-27TRAM', title: 'Will Harbor City approve the waterfront tram?', sub: 'Council vote before March 2027', featured: 1,
      news: 'Councillors scheduled a second reading after a packed public hearing on the tram extension.',
      markets: [{ t: 'PLXCOUNCIL-27TRAM', yes: 'Approved', no: 'Not approved', fair: 63 }] },
    { e: 'PLXCOUNCIL-27MAYOR', title: 'Who will win the Harbor City mayoral race?', sub: 'General election', mutually: 1, featured: 1,
      news: 'Three candidates remain after the primary; a televised debate is set for next week.',
      markets: [
        { t: 'PLXCOUNCIL-27MAYOR-OKAFOR', yes: 'Dana Okafor', fair: 48, color: '#2f6fed' },
        { t: 'PLXCOUNCIL-27MAYOR-LINDQVIST', yes: 'Per Lindqvist', fair: 34, color: '#d9480f' },
        { t: 'PLXCOUNCIL-27MAYOR-MBEKI', yes: 'Ama Mbeki', fair: 18, color: '#2b8a3e' }] },
  ] },
  { s: 'PLXCUP', title: 'Northern Cup final', cat: 'Sports', tags: ['Football'], events: [
    { e: 'PLXCUP-26FINAL', title: 'Northern Cup Final: Ravens vs Comets', sub: 'Winner', mutually: 1, live: 1, live_label: '2nd half · 61\'', featured: 1,
      news: 'The Ravens lead possession, but the Comets have had the better chances on the counter.',
      markets: [{ t: 'PLXCUP-26FINAL-RAV', yes: 'Ravens', fair: 55, color: '#7048e8' }, { t: 'PLXCUP-26FINAL-COM', yes: 'Comets', fair: 45, color: '#e8590c' }] },
  ] },
  { s: 'PLXHOOPS', title: 'Pro hoops championship', cat: 'Sports', tags: ['Basketball'], events: [
    { e: 'PLXHOOPS-27CHAMP', title: 'Pro hoops champion 2027', sub: 'Season winner', mutually: 1,
      markets: [
        { t: 'PLXHOOPS-27CHAMP-HAWKS', yes: 'Seaside Hawks', fair: 31, color: '#0b7285' },
        { t: 'PLXHOOPS-27CHAMP-BEARS', yes: 'Granite Bears', fair: 27, color: '#5c940d' },
        { t: 'PLXHOOPS-27CHAMP-OWLS', yes: 'Midnight Owls', fair: 22, color: '#862e9c' },
        { t: 'PLXHOOPS-27CHAMP-FOXES', yes: 'Desert Foxes', fair: 12, color: '#c92a2a' }] },
  ] },
  { s: 'PLXFILM', title: 'Golden Reel awards', cat: 'Culture', tags: ['Film'], events: [
    { e: 'PLXFILM-27PIC', title: 'Golden Reel for Best Picture', sub: 'Ceremony in February', mutually: 1, featured: 1,
      markets: [
        { t: 'PLXFILM-27PIC-LIGHTHOUSE', yes: 'The Last Lighthouse', fair: 44, color: '#364fc7' },
        { t: 'PLXFILM-27PIC-PAPER', yes: 'Paper Moons', fair: 29, color: '#f08c00' },
        { t: 'PLXFILM-27PIC-ORCHARD', yes: 'Orchard Road', fair: 17, color: '#2b8a3e' }] },
  ] },
  { s: 'PLXCOIN', title: 'Token price levels', cat: 'Crypto', tags: ['Prices'], events: [
    { e: 'PLXCOIN-26DEC', title: 'Will the PLX token close above $5 on Dec 31?', sub: 'Year-end close',
      markets: [{ t: 'PLXCOIN-26DEC-T5', yes: 'Above $5', no: 'At or below $5', fair: 37 }] },
  ] },
  { s: 'PLXRAIN', title: 'Monthly rainfall', cat: 'Climate', tags: ['Rain'], events: [
    { e: 'PLXRAIN-26NOV', title: 'Harbor City rainfall in November', sub: 'Total inches',
      markets: [
        { t: 'PLXRAIN-26NOV-B2', yes: 'Under 2 in', fair: 21 },
        { t: 'PLXRAIN-26NOV-B4', yes: '2 to 4 in', fair: 52 },
        { t: 'PLXRAIN-26NOV-B6', yes: 'Over 4 in', fair: 27 }] },
  ] },
  { s: 'PLXRATE', title: 'Central bank decision', cat: 'Economics', tags: ['Rates'], events: [
    { e: 'PLXRATE-26DEC', title: 'Central bank decision in December', sub: 'Policy meeting', mutually: 1, featured: 1,
      markets: [
        { t: 'PLXRATE-26DEC-CUT', yes: 'Cut', fair: 58, color: '#1971c2' },
        { t: 'PLXRATE-26DEC-HOLD', yes: 'Hold', fair: 39, color: '#868e96' },
        { t: 'PLXRATE-26DEC-HIKE', yes: 'Hike', fair: 3, color: '#e03131' }] },
  ] },
  { s: 'PLXLAUNCH', title: 'Orbital launches', cat: 'Tech & Science', tags: ['Space'], events: [
    { e: 'PLXLAUNCH-27Q1', title: 'Will the Kestrel rocket reach orbit by March?', sub: 'Before April 1, 2027',
      markets: [{ t: 'PLXLAUNCH-27Q1', yes: 'Reaches orbit', no: 'Does not', fair: 46 }] },
  ] },
  { s: 'PLXGADGET', title: 'Device launches', cat: 'Companies', tags: ['Hardware'], events: [
    { e: 'PLXGADGET-27FOLD', title: 'Will Nimbus ship a foldable tablet in 2027?', sub: 'Before 2028',
      markets: [{ t: 'PLXGADGET-27FOLD', yes: 'Ships', no: 'Does not ship', fair: 22 }] },
    { e: 'PLXGADGET-27SOON', title: 'Nimbus keynote date announced?', sub: 'Opens soon', opensIn: 2 * D,
      markets: [{ t: 'PLXGADGET-27SOON', yes: 'Announced', no: 'Not announced', fair: 50 }] },
  ] },
  { s: 'PLXINDEX', title: 'Equity index close', cat: 'Financials', tags: ['Indices'], events: [
    { e: 'PLXINDEX-26W45', title: 'Harbor 100 index up this week?', sub: 'Weekly close', closesIn: 3 * D,
      markets: [{ t: 'PLXINDEX-26W45', yes: 'Up', no: 'Down', fair: 54 }] },
  ] },
];

function seed(db, { reset = false } = {}) {
  if (reset) {
    db.exec(`DELETE FROM recently_visited; DELETE FROM watchlist; DELETE FROM ledger; DELETE FROM settlements; DELETE FROM positions; DELETE FROM fills; DELETE FROM trades; DELETE FROM orders; DELETE FROM markets; DELETE FROM events; DELETE FROM series; DELETE FROM user_settings; DELETE FROM sessions; DELETE FROM users; DELETE FROM meta;`);
  }
  if (db.prepare('SELECT COUNT(*) c FROM series').get().c > 0) return false;
  const r = rng(20261102);
  const now = Date.now();
  tx(db, () => {
    const mk = (email, name, cents, admin, system) => {
      const id = newId('u_');
      db.prepare('INSERT INTO users(id,email,display_name,password_hash,is_admin,is_system,balance_cents,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, email, name, hashPassword(system ? newId() : 'parlance-admin'), admin, system, cents, nowIso());
      return id;
    };
    const lp = mk('liquidity@parlance.local', 'Parlance Liquidity', 1_000_000_00, 0, 1);
    mk('admin@parlance.local', 'Exchange Admin', 0, 1, 0);
    let seq = 0;
    for (const s of CATALOG) {
      db.prepare('INSERT INTO series(ticker,title,slug,category,tags,frequency,fee_type,fee_multiplier,settlement_sources,rules) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(s.s, s.title, slugify(s.title), s.cat, JSON.stringify(s.tags), 'custom', 'quadratic', 1,
          JSON.stringify([{ name: 'Parlance Resolution Desk', url: 'https://example.org/resolution' }]),
          `Contracts in the ${s.title} series resolve from the named settlement source. Each contract pays $1.00 if its outcome occurs, otherwise $0.00.`);
      for (const ev of s.events) {
        db.prepare('INSERT INTO events(ticker,series_ticker,title,sub_title,category,mutually_exclusive,is_live,live_label,news,featured,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(ev.e, s.s, ev.title, ev.sub || '', s.cat, ev.mutually ? 1 : 0, ev.live ? 1 : 0, ev.live_label || '', ev.news || '', ev.featured ? 1 : 0, iso(now - 20 * D));
        for (const m of ev.markets) {
          const openTime = ev.opensIn ? now + ev.opensIn : now - 14 * D;
          const closeTime = ev.closesIn ? now + ev.closesIn : now + 120 * D;
          const status = ev.opensIn ? 'initialized' : 'active';
          db.prepare('INSERT INTO markets(ticker,event_ticker,title,yes_sub_title,no_sub_title,color,status,open_time,close_time,expected_expiration_time,settlement_timer_seconds,rules_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(m.t, ev.e, ev.markets.length > 1 ? `${ev.title} — ${m.yes}` : ev.title, m.yes, m.no || `Not ${m.yes}`, m.color || '#5b5bd6', status,
              iso(openTime), iso(closeTime), iso(closeTime + H), 5,
              `If "${m.yes}" is confirmed by the settlement source, this market resolves YES. Otherwise it resolves NO.`, nowIso(), nowIso());
          if (status !== 'active') continue;
          // Seven days of hourly trade history from a bounded random walk ending at the fair price.
          const path = [];
          let p = m.fair;
          for (let i = 0; i < 168; i++) { path.unshift(p); p = Math.max(2, Math.min(98, p + Math.round((r() - 0.5) * 6))); }
          path.forEach((price, i) => {
            const ts = now - (168 - i) * H + Math.floor(r() * 50 * 60 * 1000);
            db.prepare('INSERT INTO trades(id,market_ticker,yes_price_cents,count,taker_side,created_ts) VALUES(?,?,?,?,?,?)')
              .run(newId('t_'), m.t, price, 5 + Math.floor(r() * 400), r() > 0.5 ? 'yes' : 'no', ts);
          });
          // Resting liquidity on both sides of the book.
          for (let lvl = 1; lvl <= 4; lvl++) {
            const yb = m.fair - lvl;
            const nb = 100 - (m.fair + lvl);
            for (const [side, price] of [['yes', yb], ['no', nb]]) {
              if (price < 1 || price > 99) continue;
              const cnt = 50 * lvl + Math.floor(r() * 200);
              seq += 1;
              db.prepare("INSERT INTO orders(id,seq,user_id,market_ticker,side,price_cents,initial_count,remaining_count,reserved_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'resting',?,?)")
                .run(newId('o_'), seq, lp, m.t, side, price, cnt, cnt, cnt * (price + 2), nowIso(), nowIso());
            }
          }
        }
      }
    }
    // Liquidity reservations come out of the liquidity account's available cash.
    const held = db.prepare("SELECT COALESCE(SUM(reserved_cents),0) c FROM orders WHERE user_id=? AND status='resting'").get(lp).c;
    db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id=?').run(held, lp);
    db.prepare("INSERT INTO meta(key,value) VALUES('order_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(seq));
  });
  return true;
}

module.exports = { seed, CATALOG };

if (require.main === module) {
  const file = process.env.DB_FILE || require('node:path').join(__dirname, '..', 'data', 'parlance.db');
  const db = open(file);
  const did = seed(db, { reset: process.argv.includes('--reset') });
  console.log(did ? `seeded ${file}` : `already seeded ${file}`);
}

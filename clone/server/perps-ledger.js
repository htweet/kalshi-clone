'use strict';
// Perps double-entry sub-journal (PLAN Phase 6, CLONE_SPEC.md §34.6). The main journal (server/journal.js) works in
// whole cents and sees Perps as one account, `perps:collateral`. Inside Perps money moves in centicents (1 cc = $0.0001,
// the perps tick), so every perps money movement is journaled here, double-entry, in integer centicents:
//
//   psub:<uid>:<n>:avail     free collateral of subaccount n   (= perp_accounts.available_cc for n = 0,
//                                                                 perp_subaccounts.available_cc for n >= 1)
//   psub:<uid>:<n>:reserved  held by the subaccount's resting orders (= SUM(perp_orders.reserved_cc))
//   psub:<uid>:<n>:margin    locked in the subaccount's positions   (= SUM(perp_positions.margin_cc))
//   perps:bridge             money that crossed from the main journal (= -100 x main `perps:collateral`)
//   perps:fees               trading fees collected
//   perps:pnl                realized PnL paid out (its balance is minus the realized PnL paid to every party)
//   perps:funding            funding clearing; every funding event sums to zero, so this stays at zero
//   perps:insurance          liquidation fees in, shortfalls out (never below zero)
//   perps:backstop           shortfalls the insurance fund could not cover (the house's loss)
//   perps:lp_capital         the liquidity account's float
//   perps:opening            opening balances of databases that predate this journal
//   perps:reset:<batch>      balances closed by the switch to production (server/play-mode.js)
//
// Realized PnL is exact: positions keep an integer cost basis in unit-centicents (cost_ucc = SUM(units x price_cc)), so
// the realized PnL of all parties together equals the signed cost basis of all open positions, to the unit. The user
// side is paid in whole centicents rounded down; the sub-centicent remainder is the `rounding_ucc` tally in perp_meta.
// The audit (registered with the main ledger audit) proves: every entry balances; materialised balances equal the posting
// sums; every subaccount's three accounts equal their tables; nothing is negative; funding nets to zero; the bridge
// matches the main journal; and   -100 x perps:pnl + rounding_ucc = SUM(signed cost basis of every open position).
// Entries carry the money mode and epoch (server/play-mode.js installs the triggers on perp_journal_entries too).
const { newId } = require('./util');
const { tx } = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perp_journal_entries (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, user_id TEXT, memo TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_perp_journal_entries_ts ON perp_journal_entries(ts);
CREATE TABLE IF NOT EXISTS perp_journal_postings (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL REFERENCES perp_journal_entries(id), account TEXT NOT NULL, amount_cc INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_perp_journal_postings_account ON perp_journal_postings(account);
CREATE INDEX IF NOT EXISTS idx_perp_journal_postings_entry ON perp_journal_postings(entry_id);
CREATE TABLE IF NOT EXISTS perp_journal_balances (account TEXT PRIMARY KEY, balance_cc INTEGER NOT NULL);
`;
const H = {
  bridge: 'perps:bridge', fees: 'perps:fees', pnl: 'perps:pnl', funding: 'perps:funding', insurance: 'perps:insurance',
  backstop: 'perps:backstop', lp: 'perps:lp_capital', opening: 'perps:opening',
};
const A = {
  avail: (uid, sub = 0) => `psub:${uid}:${sub}:avail`,
  reserved: (uid, sub = 0) => `psub:${uid}:${sub}:reserved`,
  margin: (uid, sub = 0) => `psub:${uid}:${sub}:margin`,
};
const ready = new WeakSet();
function init(db) {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  ready.add(db);
}
const balanceOf = (db, account) => { init(db); return db.prepare('SELECT balance_cc c FROM perp_journal_balances WHERE account=?').get(account)?.c ?? 0; };

// One balanced entry: postings [[account, cc], ...]; zero postings are dropped, same-account postings merge.
function post(db, { kind, ref = null, userId = null, memo = '', ts = Date.now() }, postings) {
  init(db);
  const m = new Map();
  for (const [a, c] of postings) {
    if (typeof a !== 'string' || !a || !Number.isInteger(c)) throw new Error(`perps journal: invalid posting (${kind}: ${a} ${c})`);
    m.set(a, (m.get(a) || 0) + c);
  }
  const list = [...m].filter(([, c]) => c !== 0);
  if (!list.length) return null;
  const sum = list.reduce((s, [, c]) => s + c, 0);
  if (sum !== 0) throw new Error(`perps journal: unbalanced entry (${kind}, sum ${sum})`);
  const id = newId('pje_');
  return tx(db, () => {
    db.prepare('INSERT INTO perp_journal_entries(id,ts,kind,ref,user_id,memo) VALUES(?,?,?,?,?,?)').run(id, ts, kind, ref, userId, String(memo).slice(0, 200));
    const ins = db.prepare('INSERT INTO perp_journal_postings(entry_id,account,amount_cc) VALUES(?,?,?)');
    const bal = db.prepare('INSERT INTO perp_journal_balances(account,balance_cc) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET balance_cc=balance_cc+excluded.balance_cc');
    for (const [a, c] of list) { ins.run(id, a, c); bal.run(a, c); }
    return id;
  });
}

// The audit (pure reads). `mainGot(account)` reads the main journal's posting sums (for the bridge check).
function audit(db, { mainGot = null, lpId = null } = {}) {
  init(db);
  const problems = [];
  const P = (check, detail, extra = {}) => problems.push({ check: `perps_${check}`, detail, ...extra });
  for (const r of db.prepare('SELECT entry_id, SUM(amount_cc) s, COUNT(*) n FROM perp_journal_postings GROUP BY entry_id HAVING s<>0 OR n<2 LIMIT 50').all()) P('entry_balanced', 'perps journal entry does not sum to zero', { entry_id: r.entry_id, actual_cc: r.s });
  const sums = new Map(db.prepare('SELECT account, SUM(amount_cc) s FROM perp_journal_postings GROUP BY account').all().map((r) => [r.account, r.s]));
  const got = (a) => sums.get(a) || 0;
  for (const r of db.prepare('SELECT account, balance_cc b FROM perp_journal_balances').all()) if (r.b !== got(r.account)) P('materialised_balance', 'perp_journal_balances differs from the posting sum', { account: r.account, expected_cc: got(r.account), actual_cc: r.b });
  // Subaccount tables vs postings, and nothing negative.
  const expect = new Map();
  const set = (acct, v) => expect.set(acct, (expect.get(acct) || 0) + v);
  for (const r of db.prepare('SELECT user_id, available_cc c FROM perp_accounts').all()) set(A.avail(r.user_id, 0), r.c);
  for (const r of db.prepare('SELECT user_id, subaccount, available_cc c FROM perp_subaccounts WHERE subaccount>0').all()) set(A.avail(r.user_id, r.subaccount), r.c);
  for (const r of db.prepare("SELECT user_id, subaccount, SUM(reserved_cc) c FROM perp_orders WHERE reserved_cc<>0 GROUP BY user_id, subaccount").all()) set(A.reserved(r.user_id, r.subaccount), r.c);
  for (const r of db.prepare('SELECT user_id, subaccount, SUM(margin_cc) c FROM perp_positions GROUP BY user_id, subaccount').all()) set(A.margin(r.user_id, r.subaccount), r.c);
  const accts = new Set([...expect.keys(), ...[...sums.keys()].filter((a) => a.startsWith('psub:'))]);
  for (const a of accts) {
    const e = expect.get(a) || 0;
    if (e !== got(a)) P('subaccount', 'subaccount table vs postings', { account: a, expected_cc: e, actual_cc: got(a) });
    if (e < 0) P('non_negative', 'negative perps balance', { account: a, actual_cc: e });
  }
  if (got(H.funding) !== 0) P('funding_zero_sum', 'funding payments do not net to zero', { account: H.funding, actual_cc: got(H.funding) });
  if (got(H.insurance) < 0) P('insurance_non_negative', 'the insurance fund is overdrawn', { account: H.insurance, actual_cc: got(H.insurance) });
  if (mainGot) {
    const want = -100 * mainGot('perps:collateral');
    if (got(H.bridge) !== want) P('bridge', 'perps:bridge vs 100 x main perps:collateral', { account: H.bridge, expected_cc: want, actual_cc: got(H.bridge) });
  }
  // Exact PnL conservation (see the header).
  const signed = db.prepare('SELECT COALESCE(SUM(CASE WHEN qty>0 THEN cost_ucc WHEN qty<0 THEN -cost_ucc ELSE 0 END),0) s FROM perp_positions').get().s;
  const dust = Number(db.prepare("SELECT value FROM perp_meta WHERE key='rounding_ucc'").get()?.value || 0);
  if (-100 * got(H.pnl) + dust !== signed) P('pnl_conservation', 'realized PnL paid + rounding differs from the open positions\' signed cost basis', { account: H.pnl, expected_ucc: signed, actual_ucc: -100 * got(H.pnl) + dust });
  const flat = db.prepare('SELECT COUNT(*) c FROM perp_positions WHERE qty=0 AND (cost_ucc<>0 OR margin_cc<>0)').get().c;
  if (flat) P('flat_positions', 'flat positions still hold cost or margin', { actual: flat });
  const grand = [...sums.values()].reduce((x, y) => x + y, 0);
  if (grand !== 0) P('trial_balance', 'perps postings do not sum to zero', { actual_cc: grand });
  void lpId;
  const totals = {};
  for (const [a, s] of sums) { const k = /^psub:.*:(avail|reserved|margin)$/.exec(a)?.[1]; const key = k ? `subaccounts ${k}` : a.startsWith('perps:reset:') ? 'perps:reset' : a; totals[key] = (totals[key] || 0) + s; }
  return { ok: problems.length === 0, problems, totals, entries: db.prepare('SELECT COUNT(*) c FROM perp_journal_entries').get().c };
}

module.exports = { init, post, balanceOf, audit, A, H, SCHEMA };

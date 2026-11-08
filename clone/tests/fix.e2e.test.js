'use strict';
// Phase 7 A17 (CLONE_SPEC.md §35.8): the simulated FIX 4.4 gateway over real TCP — off by default and switched on by
// the api.fix flag; signed Logon (good, bad signature, wrong scope); order entry D → ExecutionReport, cancel / replace,
// rejects; fills; mass cancel; a sequence gap answered with ResendRequest and filled with SequenceReset-GapFill; a
// counterparty ResendRequest answered with PossDup resends; garbled CheckSum ignored; too-low MsgSeqNum → Logout;
// market data snapshot + incremental refresh; RFQ; Perps; a drop copy session receiving executions from every channel;
// Admin › API keys › FIX sessions disconnect in the browser; sequence numbers surviving a restart; and the switch to
// production logging FIX sessions out while API keys survive and API orders and order groups are reset.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { harness, newPage, uiLogIn, sleep, eventually, PW } = require('./lib/api-helpers');
const { FixClient } = require('./lib/fix-client');
const { encode, utc } = require('../server/fix');
const { Client } = require('./lib/client');

const H = harness('fix');
let browser; let admin; let admin2; let fred; let fk; let T; let fx; let dc;
const B = '/trade-api/v2';
const stepped = async (c, m, p, b) => { let r = await c.call(m, p, b); if (r.code === 'step_up_required') { await c.call('POST', '/v1/step_up', { password: PW }); r = await c.call(m, p, b); } return r; };
const port = () => eventually(() => H.srv.fix.port() || false, { timeout: 8000 });

before(async () => {
  await H.start();
  browser = await chromium.launch();
  admin = await H.adminClient();
  // Play mode first (the production switch at the end needs it; it must start before any money exists).
  assert.equal((await stepped(admin, 'PUT', '/v1/admin/play_mode', { on: true, reason: 'e2e play mode for the fix suite' })).status, 200);
  const c2 = await new Client(H.BASE, 'admin2').signUp(H.email('admin2'), PW, 'Second Admin');
  H.run('UPDATE users SET is_admin=1 WHERE id=?', c2.uid);
  admin2 = await new Client(H.BASE, 'admin2').logIn(H.email('admin2'), PW);
  fred = await H.user('fred', { dollars: 3000 });
  fk = await H.key(fred, { kind: 'rsa', label: 'FIX order entry' });
  T = H.openMarket();
});
after(async () => { fx?.close(); dc?.close(); await browser?.close(); await H.stop(); H.cleanup(); });

test('off by default; the flag starts the acceptor; logon is signed (bad signature and wrong scope refused)', async () => {
  assert.equal(H.srv.fix.port(), null, 'no listener while api.fix is off');
  assert.equal((await stepped(admin, 'PUT', '/v1/admin/flags/api.fix', { enabled: true, reason: 'e2e fix on' })).status, 200);
  const p = await port();
  // A logon signed with another key's private key is refused with a Logout, then the socket closes.
  const other = await H.key(fred, { kind: 'ed25519', scopes: ['read'], label: 'read only' });
  const bad = new FixClient(p, { sender: 'BADFIRM', keyId: fk.id, privateKey: other.privateKey });
  await bad.connect(); bad.logon();
  const lo = await bad.waitFor((m) => m.type === '5');
  assert.match(lo.get(58), /logon refused/);
  await bad.closedP;
  // A read-only key cannot open an order-entry session.
  const ro = new FixClient(p, { sender: 'ROFIRM', keyId: other.id, privateKey: other.privateKey });
  await ro.connect(); ro.logon();
  await ro.waitFor((m) => m.type === '5'); await ro.closedP;
  assert.ok(H.q("SELECT * FROM security_events WHERE kind='fix_logon_failed'").length >= 2);
  // The real logon.
  fx = new FixClient(p, { sender: 'FREDFIRM', keyId: fk.id, privateKey: fk.privateKey });
  await fx.connect(); fx.logon({ hb: 30 });
  const ack = await fx.waitFor((m) => m.type === 'A');
  assert.equal(ack.get(108), '30'); assert.equal(ack.get(141), 'Y'); assert.equal(ack.get(56), 'FREDFIRM'); assert.equal(ack.get(34), '1');
});

test('order entry: New, Replace, Cancel, rejects, fills, Perps and mass cancel as ExecutionReports', async () => {
  fx.send('D', [[11, 'F-1'], [55, T], [54, '1'], [38, '2'], [40, '2'], [44, '0.0300']]);
  const nw = await fx.waitFor((m) => m.type === '8' && m.get(11) === 'F-1');
  assert.equal(nw.get(150), '0'); assert.equal(nw.get(39), '0'); assert.equal(nw.get(44), '0.0300'); assert.equal(nw.get(151), '2.00'); assert.equal(nw.get(20001), 'Y');
  const oid = nw.get(37);
  assert.equal(H.q1('SELECT source, client_order_id FROM orders WHERE id=?', oid).source, 'fix');
  fx.send('G', [[11, 'F-2'], [41, 'F-1'], [38, '3'], [44, '0.0400']]);
  const rp = await fx.waitFor((m) => m.type === '8' && m.get(150) === '5');
  assert.equal(rp.get(11), 'F-2'); assert.equal(rp.get(41), 'F-1'); assert.equal(rp.get(44), '0.0400'); assert.equal(rp.get(38), '3.00'); assert.equal(rp.get(37), oid);
  fx.send('F', [[11, 'F-3'], [41, 'F-2']]);
  const cx = await fx.waitFor((m) => m.type === '8' && m.get(150) === '4');
  assert.equal(cx.get(11), 'F-3'); assert.equal(cx.get(39), '4'); assert.equal(H.q1('SELECT status FROM orders WHERE id=?', oid).status, 'canceled');
  // Rejects: unknown order on cancel (9), unknown symbol and missing price on new orders (8 / 150=8), duplicate ClOrdID.
  fx.send('F', [[11, 'F-4'], [41, 'NOPE']]);
  const cr = await fx.waitFor((m) => m.type === '9');
  assert.equal(cr.get(434), '1'); assert.equal(cr.get(102), '1');
  fx.send('D', [[11, 'F-5'], [55, 'NOPE-NOPE'], [54, '1'], [38, '1'], [40, '2'], [44, '0.1000']]);
  assert.match((await fx.waitFor((m) => m.type === '8' && m.get(11) === 'F-5')).get(58), /unknown symbol/);
  fx.send('D', [[11, 'F-1'], [55, T], [54, '1'], [38, '1'], [40, '2'], [44, '0.0200']]);
  assert.match((await fx.waitFor((m) => m.type === '8' && m.get(150) === '8' && m.get(58) === 'duplicate ClOrdID')).get(11), /F-1/);
  // A market buy fills against the book: New, then Trade with LastPx / LastQty.
  fx.send('D', [[11, 'F-6'], [55, T], [54, '1'], [38, '1'], [40, '1']]);
  const tr = await fx.waitFor((m) => m.type === '8' && m.get(11) === 'F-6' && m.get(150) === 'F');
  assert.equal(tr.get(32), '1.00'); assert.match(tr.get(31), /^0\.\d{4}$/); assert.equal(tr.get(39), '2');
  // Perps over FIX.
  assert.equal((await fred.call('POST', '/v1/perps/transfers', { direction: 'to_perps', amount_dollars: 500 })).status, 201);
  const mark = Number((await fk.signed.call('GET', `${B}/margin/markets/PLXBTCPERP`)).body.market.mark_price);
  fx.send('D', [[11, 'P-1'], [55, 'PLXBTCPERP'], [54, '1'], [38, '1'], [40, '2'], [44, (mark * 0.9).toFixed(4)], [20002, '2']]);
  const pn = await fx.waitFor((m) => m.type === '8' && m.get(11) === 'P-1');
  assert.equal(pn.get(150), '0');
  assert.equal(H.q1('SELECT status FROM perp_orders WHERE id=?', pn.get(37)).status, 'resting');
  // Mass cancel: every resting order (Predictions and Perps).
  fx.send('D', [[11, 'F-7'], [55, T], [54, '1'], [38, '1'], [40, '2'], [44, '0.0200']]);
  await fx.waitFor((m) => m.type === '8' && m.get(11) === 'F-7');
  fx.send('q', [[11, 'M-1'], [530, '7']]);
  const mr = await fx.waitFor((m) => m.type === 'r');
  assert.equal(mr.get(531), '7'); assert.equal(mr.get(533), '2');
  assert.equal(H.q1("SELECT COUNT(*) c FROM perp_orders WHERE user_id=? AND status='resting'", fred.uid).c, 0);
  // Unsupported message type → BusinessMessageReject.
  fx.send('AE', [[571, 'X']]);
  assert.equal((await fx.waitFor((m) => m.type === 'j')).get(380), '3');
});

test('sequence numbers: gap → ResendRequest → GapFill; their ResendRequest → PossDup resends; garbled CheckSum ignored; too low → Logout', async () => {
  const expected = fx.seq;
  // Skip two numbers: the gateway asks for a resend and ignores the out-of-order message.
  fx.seq += 2;
  fx.send('1', [[112, 'GAP-TEST']]);
  const rr = await fx.waitFor((m) => m.type === '2');
  assert.equal(rr.get(7), String(expected)); assert.equal(rr.get(16), '0');
  assert.ok(!fx.messages.some((m) => m.type === '0' && m.get(112) === 'GAP-TEST'), 'the out-of-order message is not processed');
  // Fill the gap (SequenceReset-GapFill up to the test request), then resend the test request.
  fx.send('4', [[123, 'Y'], [36, expected + 2]], { seq: expected, extraHead: [[43, 'Y']] });
  fx.send('1', [[112, 'GAP-TEST']], { seq: expected + 2, extraHead: [[43, 'Y']] });
  await fx.waitFor((m) => m.type === '0' && m.get(112) === 'GAP-TEST');
  fx.seq = expected + 3;
  // Their ResendRequest for our messages 2-5: application messages come back with PossDupFlag=Y, admin ones as gap fill.
  const before = fx.messages.length;
  fx.send('2', [[7, 2], [16, 5]]);
  await fx.waitFor((m) => fx.messages.indexOf(m) >= before && m.get(43) === 'Y' && m.type === '8');
  const resent = fx.messages.slice(before).filter((m) => m.get(43) === 'Y');
  assert.ok(resent.every((m) => m.get(122)), 'OrigSendingTime on every resend');
  assert.ok(resent.some((m) => m.type === '8' && m.get(11) === 'F-1'), 'the first ExecutionReport is resent');
  // A garbled message (wrong CheckSum) is ignored: the session lives on and the next sequence number still fits.
  const msg = encode([[35, '1'], [49, 'FREDFIRM'], [56, 'PARLANCE'], [34, fx.seq], [52, utc()], [112, 'GARBLED']]);
  msg[msg.length - 2] = msg[msg.length - 2] === 0x30 ? 0x31 : 0x30;
  fx.raw(msg);
  fx.send('1', [[112, 'AFTER-GARBLED']]);
  await fx.waitFor((m) => m.type === '0' && m.get(112) === 'AFTER-GARBLED');
  assert.ok(!fx.messages.some((m) => m.get(112) === 'GARBLED'));
  assert.ok(Number(H.q1("SELECT in_seq FROM fix_session_state WHERE sender_comp_id='FREDFIRM'").in_seq) === fx.seq, 'inbound sequence persisted');
  // Too low without PossDupFlag: Logout. Reconnect continuing the persisted sequence numbers (no reset).
  // The tier caps FIX sessions per key (Basic: one): a second session is refused until the key moves to Advanced.
  const capped = new FixClient(await port(), { sender: 'LOWFIRM', keyId: fk.id, privateKey: fk.privateKey });
  await capped.connect(); capped.logon(); await capped.waitFor((m) => m.type === '5'); await capped.closedP;
  assert.ok(H.q("SELECT detail FROM security_events WHERE kind='fix_logon_failed'").some((e) => /session cap/.test(e.detail)));
  assert.equal((await admin.call('PUT', `/v1/admin/api_keys/${fk.id}/tier`, { tier: 'advanced', reason: 'two FIX sessions' })).status, 200);
  const low = new FixClient(await port(), { sender: 'LOWFIRM', keyId: fk.id, privateKey: fk.privateKey });
  await low.connect(); low.logon(); await low.waitFor((m) => m.type === 'A');
  low.send('1', [[112, 'X']], { seq: 1 });
  assert.match((await low.waitFor((m) => m.type === '5')).get(58), /MsgSeqNum too low/);
  await low.closedP;
});

test('drop copy receives every channel\'s executions; market data snapshot and refresh; RFQ quotes as FIX messages', async () => {
  const rk = await H.key(fred, { kind: 'ed25519', scopes: ['read'], label: 'drop copy' });
  dc = new FixClient(await port(), { sender: 'FREDDC', target: 'PARLANCEDC', keyId: rk.id, privateKey: rk.privateKey });
  await dc.connect(); dc.logon(); await dc.waitFor((m) => m.type === 'A');
  // Orders from REST and from the web app both reach the drop copy; order entry there is refused.
  const r = await fk.signed.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2, client_order_id: 'rest-1' });
  const rest = r.body.order.order_id;
  await dc.waitFor((m) => m.type === '8' && m.get(37) === rest && m.get(150) === '0');
  const web = await fred.call('POST', `/v1/users/${fred.uid}/orders`, { ticker: T, side: 'no', type: 'limit', price: 2, count: 1 });
  assert.equal(web.status, 201);
  const wr = await dc.waitFor((m) => m.type === '8' && m.get(37) === web.body.order.order_id);
  assert.equal(wr.get(20001), 'N'); assert.equal(wr.get(20003), 'user');
  await fk.signed.call('DELETE', `${B}/portfolio/orders/${rest}`);
  await dc.waitFor((m) => m.type === '8' && m.get(37) === rest && m.get(150) === '4');
  assert.ok(!fx.messages.some((m) => m.type === '8' && m.get(37) === web.body.order.order_id), 'the order-entry session only reports its own orders');
  dc.send('D', [[11, 'DC-1'], [55, T], [54, '1'], [38, '1'], [40, '2'], [44, '0.0200']]);
  assert.equal((await dc.waitFor((m) => m.type === 'j')).get(380), '4');
  // Market data: snapshot, then an incremental refresh when the book changes.
  fx.send('V', [[262, 'MD-1'], [263, '1'], [264, 0], [146, 1], [55, T]]);
  const w = await fx.waitFor((m) => m.type === 'W' && m.get(262) === 'MD-1');
  assert.ok(Number(w.get(268)) > 0); assert.equal(w.get(55), T);
  fx.send('D', [[11, 'MD-ORDER'], [55, T], [54, '1'], [38, '1'], [40, '2'], [44, '0.0100']]);
  const x = await fx.waitFor((m) => m.type === 'X' && m.all(270).includes('0.0100'));
  assert.equal(x.get(262), 'MD-1');
  fx.send('V', [[262, 'MD-2'], [263, '0'], [146, 1], [55, 'NOPE-NOPE']]);
  assert.equal((await fx.waitFor((m) => m.type === 'Y')).get(262), 'MD-2');
  // RFQ: QuoteRequest opens one; a maker's quote arrives as a Quote (S).
  const maker = await H.user('maker', { dollars: 1000 });
  for (const c of [fred, maker]) assert.equal((await c.call('PUT', `/v1/users/${c.uid}/properties`, { properties: { rfq_enabled: true } })).status, 200);
  fx.send('R', [[131, 'QR-1'], [146, 1], [55, T], [38, '5']]);
  const ai = await fx.waitFor((m) => m.type === 'AI' && m.get(131) === 'QR-1');
  assert.equal(ai.get(297), '0');
  const q = await maker.call('POST', '/v1/communications/quotes', { rfq_id: ai.get(117), yes_bid: '0.40', no_bid: '0.50' });
  assert.equal(q.status, 201, q.text);
  const sq = await fx.waitFor((m) => m.type === 'S' && m.get(131) === 'QR-1');
  assert.equal(sq.get(132), '0.4000'); assert.equal(sq.get(133), '0.5000');
});

test('Admin › API keys › FIX sessions: live list and disconnect with a reason (browser); sequence numbers survive a restart', async () => {
  const ap = await newPage(browser);
  await uiLogIn(ap, H.BASE, H.ADMIN.email);
  await ap.goto(`${H.BASE}/admin/api_keys`);
  await ap.waitForSelector('[data-testid=adm-fix-state][data-listening="1"]');
  assert.equal(await ap.locator('[data-testid=adm-fix-row]').count(), 2);
  const row = ap.locator(`[data-testid=adm-fix-row][data-key="${fk.id}"]`);
  await row.locator('[data-testid=adm-fix-disconnect]').click();
  await ap.fill('[data-testid=confirm-reason]', 'support: reset this session');
  await ap.click('[data-testid=confirm-ok]');
  const lo = await fx.waitFor((m) => m.type === '5');
  assert.match(lo.get(58), /disconnected by Parlance support/);
  await fx.closedP;
  await ap.waitForFunction(() => document.querySelectorAll('[data-testid=adm-fix-row]').length === 1, null, { timeout: 8000 });
  assert.equal(H.q1("SELECT reason FROM admin_audit WHERE action='fix.disconnect'").reason, 'support: reset this session');
  assert.deepEqual(ap.errors, []);
  await ap.context().close();
  // Restart: the flag, the keys and the session's sequence numbers persist; logon continues the numbering.
  const st = H.q1("SELECT * FROM fix_session_state WHERE sender_comp_id='FREDFIRM'");
  dc.close();
  await H.stop();
  await H.start();
  admin = await H.adminClient(); admin2 = await new Client(H.BASE, 'admin2').logIn(H.email('admin2'), PW); fred = await new Client(H.BASE, 'fred').logIn(H.email('fred'), PW);
  fx = new FixClient(await port(), { sender: 'FREDFIRM', keyId: fk.id, privateKey: fk.privateKey });
  fx.seq = st.in_seq;
  await fx.connect(); fx.logon({ reset: false });
  const ack = await fx.waitFor((m) => m.type === 'A');
  assert.equal(Number(ack.get(34)), st.out_seq, 'outbound numbering continues');
  assert.equal(ack.get(141), undefined);
});

test('switch to production: FIX sessions are logged out, API keys survive, API orders and order groups are reset', async () => {
  const r = await fk.signed.call('POST', `${B}/portfolio/orders`, { ticker: T, side: 'yes', action: 'buy', count: 1, yes_price: 2 });
  const oid = r.body.order.order_id;
  const g = (await fk.signed.call('POST', `${B}/portfolio/order_groups`, { contracts_limit: 3 })).body.order_group_id;
  const sw = await stepped(admin, 'POST', '/v1/admin/play_mode/production_switch', { reason: 'go live', confirm: 'RESET' });
  assert.ok(sw.status < 300, sw.text);
  const ap0 = H.q1("SELECT id FROM pm_approvals WHERE status='pending'");
  const ok = await stepped(admin2, 'POST', `/v1/admin/play_mode/approvals/${ap0.id}/approve`, { confirm: 'RESET' });
  assert.equal(ok.status, 200, ok.text);
  const lo = await fx.waitFor((m) => m.type === '5');
  assert.match(lo.get(58), /switched to production/);
  await fx.closedP;
  assert.equal(H.q1('SELECT status FROM orders WHERE id=?', oid).status, 'canceled');
  assert.equal(H.q1('SELECT status, status_reason FROM order_groups WHERE id=?', g).status_reason, 'production_reset');
  assert.equal(H.q1('SELECT status FROM api_keys WHERE id=?', fk.id).status, 'active');
  const counts = JSON.parse(H.q1('SELECT counts_json FROM pm_reset_batches').counts_json);
  assert.ok(counts.api_order_groups >= 1); assert.ok(counts.api_keys_kept >= 1);
  // The key still works in the real-money epoch (balance zero after the reset).
  const bal = await fk.signed.call('GET', `${B}/portfolio/balance`);
  assert.equal(bal.status, 200); assert.equal(bal.body.balance, 0);
  // And a new FIX logon works.
  const again = new FixClient(await port(), { sender: 'FREDNEW', keyId: fk.id, privateKey: fk.privateKey });
  await again.connect(); again.logon(); await again.waitFor((m) => m.type === 'A'); again.close();
  await sleep(100);
});

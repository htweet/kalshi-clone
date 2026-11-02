'use strict';
// Multiplexed WebSocket (spec §7.2): /v1/ws?csrfToken=...&frontend_session=...
// Client cmds: {id, cmd:'subscribe', params:{channels:[..], market_tickers?:[..]}} | {id, cmd:'unsubscribe', params:{sids:[..]}}
// Server: {id, type:'subscribed', msg:{sid, channel}} | {id, type:'unsubscribed', msg:{sid}} | {id, type:'error', msg:{code, msg}}
//         {type, sid, seq, msg} data messages.
const { WebSocketServer } = require('ws');
const { parseCookies, SESSION_COOKIE } = require('./app');
const { dollars, fp } = require('./util');
const { fillVo, orderVo } = require('./serialize');

const PUBLIC = new Set(['ticker', 'orderbook', 'trade', 'market_lifecycle_v2', 'perp_ticker', 'perp_orderbook', 'perp_trade']);
const PRIVATE = new Set(['user_balance', 'user_orders', 'fill', 'notifications', 'perp_positions', 'perp_orders', 'perp_account']);

function attachWs(server, { db, engine }) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/v1/ws') { socket.destroy(); return; }
    let userId = null;
    const tok = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (tok) {
      const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok);
      // CSRF token in the query must match the session (spec §7.2).
      if (s && Date.parse(s.expires_at) > Date.now() && s.csrf_token === url.searchParams.get('csrfToken')) userId = s.user_id;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, userId));
  });

  wss.on('connection', (ws, userId) => {
    const c = { ws, userId, subs: new Map(), nextSid: 1, alive: true };
    clients.add(c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => clients.delete(c));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return send(c, { type: 'error', msg: { code: 1, msg: 'invalid json' } }); }
      const id = m.id;
      if (m.cmd === 'subscribe') {
        const p = m.params || {};
        const chans = Array.isArray(p.channels) ? p.channels : [];
        if (!chans.length) return send(c, { id, type: 'error', msg: { code: 2, msg: 'params.channels required' } });
        for (const ch of chans) {
          if (!PUBLIC.has(ch) && !PRIVATE.has(ch)) return send(c, { id, type: 'error', msg: { code: 8, msg: `unknown channel ${ch}` } });
          if (PRIVATE.has(ch) && !c.userId) return send(c, { id, type: 'error', msg: { code: 9, msg: 'authentication required' } });
        }
        for (const ch of chans) {
          const sid = c.nextSid++;
          const tickers = Array.isArray(p.market_tickers) && p.market_tickers.length ? new Set(p.market_tickers) : null;
          c.subs.set(sid, { channel: ch, tickers, seq: 0 });
          send(c, { id, type: 'subscribed', msg: { sid, channel: ch } });
          if (ch === 'orderbook' && tickers) for (const t of tickers) snapshot(c, sid, t);
          if (ch === 'perp_orderbook' && tickers && engine.perps) for (const t of tickers) { const sb = c.subs.get(sid); sb.seq += 1; send(c, { type: 'perp_orderbook_snapshot', sid, seq: sb.seq, msg: engine.perps.bookMsg(t) }); }
        }
      } else if (m.cmd === 'unsubscribe') {
        for (const sid of (m.params && m.params.sids) || []) c.subs.delete(sid);
        send(c, { id, type: 'unsubscribed', msg: { sids: (m.params && m.params.sids) || [] } });
      } else {
        send(c, { id, type: 'error', msg: { code: 5, msg: 'unknown command' } });
      }
    });
  });

  function send(c, obj) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
  }
  function snapshot(c, sid, ticker) {
    const b = engine.book(ticker);
    const lv = (m) => [...m.entries()].sort((a, z) => a[0] - z[0]).map(([p, n]) => [dollars(p), fp(n)]);
    const sub = c.subs.get(sid);
    sub.seq += 1;
    send(c, { type: 'orderbook_snapshot', sid, seq: sub.seq, msg: { market_ticker: ticker, yes_dollars: lv(b.yes), no_dollars: lv(b.no) } });
  }
  function publish(channel, ticker, type, msg, onlyUser) {
    for (const c of clients) {
      if (onlyUser && c.userId !== onlyUser) continue;
      for (const [sid, s] of c.subs) {
        if (s.channel !== channel) continue;
        if (ticker && s.tickers && !s.tickers.has(ticker)) continue;
        s.seq += 1;
        send(c, { type, sid, seq: s.seq, msg });
      }
    }
  }

  engine.on('ticker', (t, qq) => publish('ticker', t, 'ticker', { market_ticker: t, yes_bid_dollars: dollars(qq.yes_bid), yes_ask_dollars: dollars(qq.yes_ask), last_price_dollars: dollars(qq.last_price), previous_price_dollars: dollars(qq.previous_price), volume_fp: fp(qq.volume), open_interest_fp: fp(qq.open_interest), ts: Date.now() }));
  engine.on('book_delta', (t, deltas) => {
    for (const d of deltas) publish('orderbook', t, 'orderbook_delta', { market_ticker: t, side: d.side, price_dollars: dollars(d.price), delta_fp: fp(d.delta) });
  });
  engine.on('trade', (tr) => publish('trade', tr.market_ticker, 'trade', { trade_id: tr.trade_id, market_ticker: tr.market_ticker, yes_price_dollars: dollars(tr.yes_price), no_price_dollars: dollars(100 - tr.yes_price), count_fp: fp(tr.count), taker_side: tr.taker_side, ts: tr.ts }));
  engine.on('lifecycle', (t, eventType, status) => publish('market_lifecycle_v2', t, 'market_lifecycle_v2', { market_ticker: t, event_type: eventType, status }));
  engine.on('user_balance', (uid, cents) => publish('user_balance', null, 'user_balance', { available_dollars: dollars(cents) }, uid));
  engine.on('user_order', (uid, o) => publish('user_orders', o.market_ticker, 'user_order', orderVo(o), uid));
  engine.on('fill', (uid, f) => publish('fill', f.market_ticker, 'fill', fillVo(f), uid));
  engine.on('notification', (uid, n) => publish('notifications', null, 'notification', n, uid));
  // Perps channels (PERPS_SPEC_SECTION.md): public ticker/book/trades, private orders/positions/collateral.
  engine.on('perp_ticker', (t, msg) => publish('perp_ticker', t, 'perp_ticker', msg));
  engine.on('perp_book', (t, msg) => publish('perp_orderbook', t, 'perp_orderbook_snapshot', msg));
  engine.on('perp_trade', (t, msg) => publish('perp_trade', t, 'perp_trade', msg));
  engine.on('perp_order', (uid, o) => publish('perp_orders', o.ticker, 'perp_order', o, uid));
  engine.on('perp_position', (uid, p) => publish('perp_positions', p.market_ticker, 'perp_position', p, uid));
  engine.on('perp_account', (uid, b) => publish('perp_account', null, 'perp_account', b, uid));

  // Keep-alive pings (spec §7.1 control frames).
  const iv = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, 15000);
  wss.on('close', () => clearInterval(iv));
  return { wss, clients, close: () => { clearInterval(iv); for (const c of clients) c.ws.terminate(); wss.close(); } };
}

module.exports = { attachWs };

'use strict';
// Public WebSocket API (PLAN P7.2, CLONE_SPEC.md §35.7, §7.1, §14.11): /trade-api/ws/v2 (Predictions) and
// /trade-api/ws/v2/margin (Perps). The upgrade request carries the same signed headers as REST (method GET, the
// WebSocket path; behind the demo proxy also the /demo-api-prefixed path). Every connection belongs to a key, so the
// "private" channels carry that key owner's own data only.
//
//   commands   {id, cmd:'subscribe', params:{channels, market_ticker | market_tickers}}  → {id, type:'subscribed', msg:{channel, sid}}
//              {id, cmd:'unsubscribe', params:{sids}}                                     → {id, type:'unsubscribed', sid}
//              {id, cmd:'update_subscription', params:{sids:[sid], market_tickers, action:'add_markets'|'delete_markets'}} → {id, type:'ok', sid, ...}
//              {id, cmd:'list_subscriptions'}                                              → {id, type:'ok', msg:{subscriptions}}
//              errors: {id, type:'error', msg:{code, msg}}
//   data       {type, sid, seq, msg}; seq is contiguous per subscription (a gap means: resubscribe).
//   channels   Predictions: orderbook_delta (an orderbook_snapshot per market first, then deltas), ticker, trade,
//              market_lifecycle_v2 (public); fill, user_orders, order_group_updates, market_positions (the key's owner).
//              Perps (/margin): orderbook_delta (snapshot, then deltas computed from the engine's book snapshots),
//              ticker, trade (public); fill, user_orders, order_group_updates, market_positions, account (owner).
// Caps: connections per key from the key's tier; 64 KiB frames; 20 commands per second per connection; heartbeat
// ping every 10 s, a connection that misses two pongs is closed. Revocation, expiry, the api.ws flag going off, or the
// owner being locked closes the key's sockets (code 4401) after a session_revoked frame. Reuses the engine events that
// feed the internal /v1/ws (server/ws.js); no second matching path.
const { WebSocketServer } = require('ws');
const { ufp, dollars } = require('./util');
const P = require('./pricing');
const R = require('./api-registry');
const { s } = require('./content/api');

const CHANNELS = {
  predictions: { public: ['orderbook_delta', 'ticker', 'trade', 'market_lifecycle_v2'], private: ['fill', 'user_orders', 'order_group_updates', 'market_positions'] },
  perps: { public: ['orderbook_delta', 'ticker', 'trade'], private: ['fill', 'user_orders', 'order_group_updates', 'market_positions', 'account'] },
};
const PATHS = { '/trade-api/ws/v2': 'predictions', '/trade-api/ws/v2/margin': 'perps' };
const ERR = { bad_json: [1, 'invalid json'], params: [2, 'params.channels required'], unknown_cmd: [5, 'unknown command'], unknown_channel: [8, 'unknown channel'], ticker_required: [10, 'market_ticker or market_tickers required for this channel'], unknown_sid: [11, 'unknown subscription id'], rate: [12, 'command rate exceeded'], too_many: [13, 'too many subscriptions'] };
const HEARTBEAT_MS = 10000;

function declareChannels(registry) {
  const m = (name, summary, payload) => ({ name, summary, payload });
  const book = R.obj({ market_ticker: R.str(), yes_dollars: R.arr(R.arr(R.str())), no_dollars: R.arr(R.arr(R.str())) }, ['market_ticker']);
  const delta = R.obj({ market_ticker: R.str(), side: R.str({ enum: ['yes', 'no'] }), price_dollars: R.str(), delta_fp: R.str(), ts: R.int() }, ['market_ticker', 'side', 'price_dollars', 'delta_fp']);
  const pbook = R.obj({ market_ticker: R.str(), bids: R.arr(R.arr(R.str())), asks: R.arr(R.arr(R.str())), ts_ms: R.int() }, ['market_ticker', 'bids', 'asks']);
  const pdelta = R.obj({ market_ticker: R.str(), side: R.str({ enum: ['bid', 'ask'] }), price: R.str(), delta_fp: R.str(), ts_ms: R.int() }, ['market_ticker', 'side', 'price', 'delta_fp']);
  const base = '/trade-api/ws/v2';
  const defs = [
    ['predictions', base, 'orderbook_delta', false, 'Order book: a snapshot per market, then contiguous deltas', [m('orderbook_snapshot', 'full book', book), m('orderbook_delta', 'one level changed', delta)], ['market_ticker', 'market_tickers']],
    ['predictions', base, 'ticker', false, 'Best bid / ask, last price and volume on every change', [m('ticker', 'quote update', R.obj({ market_ticker: R.str(), price_dollars: R.dollarsN(), yes_bid_dollars: R.dollarsN(), yes_ask_dollars: R.dollarsN(), volume_fp: R.str(), open_interest_fp: R.str(), ts: R.int() }, ['market_ticker']))], ['market_ticker', 'market_tickers']],
    ['predictions', base, 'trade', false, 'Public trades', [m('trade', 'a trade', R.obj({ trade_id: R.str(), market_ticker: R.str(), yes_price_dollars: R.str(), no_price_dollars: R.str(), count_fp: R.str(), taker_side: R.str(), ts: R.int() }, ['trade_id', 'market_ticker']))], ['market_ticker', 'market_tickers']],
    ['predictions', base, 'market_lifecycle_v2', false, 'Market status changes (open, paused, closed, determined, settled)', [m('market_lifecycle_v2', 'status change', R.obj({ market_ticker: R.str(), event_type: R.str(), status: R.str(), ts: R.int() }, ['market_ticker', 'event_type']))], ['market_ticker', 'market_tickers']],
    ['predictions', base, 'fill', true, 'Your fills', [m('fill', 'one of your fills', R.ref('Fill'))], []],
    ['predictions', base, 'user_orders', true, 'Your order updates', [m('user_order', 'order state', R.ref('Order'))], []],
    ['predictions', base, 'order_group_updates', true, 'Your order groups', [m('order_group_update', 'group state', R.ref('OrderGroup'))], []],
    ['predictions', base, 'market_positions', true, 'Your position after each fill', [m('market_position', 'position', R.ref('MarketPosition'))], []],
    ['perps', `${base}/margin`, 'orderbook_delta', false, 'Perps order book: snapshot, then deltas', [m('orderbook_snapshot', 'full book', pbook), m('orderbook_delta', 'one level changed', pdelta)], ['market_ticker', 'market_tickers']],
    ['perps', `${base}/margin`, 'ticker', false, 'Perps ticker: last, mark, index, funding (at most 1/s per market)', [m('ticker', 'ticker', { type: 'object' })], ['market_ticker', 'market_tickers']],
    ['perps', `${base}/margin`, 'trade', false, 'Perps trades', [m('trade', 'a trade', { type: 'object' })], ['market_ticker', 'market_tickers']],
    ['perps', `${base}/margin`, 'fill', true, 'Your perps fills', [m('fill', 'fill', R.ref('PerpFill'))], []],
    ['perps', `${base}/margin`, 'user_orders', true, 'Your perps orders', [m('user_order', 'order', R.ref('PerpOrder'))], []],
    ['perps', `${base}/margin`, 'order_group_updates', true, 'Your perps order groups', [m('order_group_update', 'group', { type: 'object' })], []],
    ['perps', `${base}/margin`, 'market_positions', true, 'Your perps positions', [m('market_position', 'position', R.ref('PerpPosition'))], []],
    ['perps', `${base}/margin`, 'account', true, 'Your perps collateral and margin', [m('account', 'balance', R.ref('PerpBalance'))], []],
  ];
  for (const [product, path, name, priv, summary, messages, params] of defs) registry.channel({ product, path, name, private: priv, summary, description: summary, messages, params });
}

function attachTradeWs({ db, engine, apiKeys, flags, tradeApi, registry, env = 'main' }) {
  declareChannels(registry);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();
  const refuse = (socket, status, body) => {
    const text = JSON.stringify(body);
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : 'Forbidden'}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  };
  // Returns true when the path is ours (handled: accepted or refused).
  function handleUpgrade(req, socket, head, pathname) {
    const product = PATHS[pathname];
    if (!product) return false;
    let p;
    try {
      p = apiKeys.authenticate(req, { method: 'GET', paths: env === 'demo' ? [pathname, `/demo-api${pathname}`] : [pathname], stateChanging: false });
      if (!p) { refuse(socket, 401, { error: { code: 'token_authentication_failure', message: 'token authentication failure', details: s('auth.required') } }); return true; }
      if (!flags.on('api.ws', { uid: p.user.id })) { refuse(socket, 403, flags.disabledError('api.ws').toJSON()); return true; }
      if (product === 'perps') apiKeys.requireScopes(p, ['perps']);
    } catch (e) { refuse(socket, e.status || 401, e.toJSON ? e.toJSON() : { error: { code: 'token_authentication_failure', message: 'token authentication failure' } }); return true; }
    const open = [...clients].filter((c) => c.key.id === p.key.id).length;
    if (open >= p.tier.ws_connections) { apiKeys.bumpUsage(p.key.id, 'throttled'); refuse(socket, 429, { error: { code: 'too_many_requests', message: 'too many requests', details: s('rate.ws_connections', { count: open, tier: p.tier.label, max: p.tier.ws_connections }) } }); return true; }
    apiKeys.bumpUsage(p.key.id, 'ws', 1, p.ip);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, p, product));
    return true;
  }

  const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
  const err = (c, id, k, detail) => send(c, { id, type: 'error', msg: { code: ERR[k][0], msg: detail || ERR[k][1] } });
  function endClient(c, reason, code = 4401) {
    send(c, { type: 'session_revoked', msg: { reason } });
    clients.delete(c);
    try { c.ws.close(code, reason); } catch { /* ignore */ }
  }

  wss.on('connection', (ws, p, product) => {
    const c = { ws, key: p.key, user: p.user, product, subs: new Map(), nextSid: 1, alive: true, misses: 0, cmdTimes: [], sentFills: new Set(), lastBooks: new Map() };
    clients.add(c);
    ws.on('pong', () => { c.alive = true; c.misses = 0; });
    ws.on('close', () => clients.delete(c));
    ws.on('error', () => { clients.delete(c); try { ws.terminate(); } catch { /* ignore */ } });
    ws.on('message', (raw) => {
      const now = Date.now();
      c.cmdTimes = c.cmdTimes.filter((t) => now - t < 1000); c.cmdTimes.push(now);
      let m;
      try { m = JSON.parse(String(raw)); } catch { return err(c, null, 'bad_json'); }
      const id = m && Number.isInteger(m.id) ? m.id : null;
      if (c.cmdTimes.length > 20) return err(c, id, 'rate');
      const params = (m && m.params) || {};
      const tickersOf = () => { const t = params.market_tickers ?? (params.market_ticker != null ? [params.market_ticker] : null); return Array.isArray(t) ? t.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, 200).map((x) => (product === 'perps' ? x.toUpperCase() : x)) : null; };
      if (m.cmd === 'subscribe') {
        const chans = Array.isArray(params.channels) ? params.channels : [];
        if (!chans.length) return err(c, id, 'params');
        const def = CHANNELS[product];
        for (const ch of chans) if (![...def.public, ...def.private].includes(ch)) return err(c, id, 'unknown_channel', `unknown channel ${String(ch).slice(0, 40)}`);
        if (c.subs.size + chans.length > 100) return err(c, id, 'too_many');
        const tickers = tickersOf();
        if (chans.includes('orderbook_delta') && !(tickers && tickers.length)) return err(c, id, 'ticker_required');
        for (const ch of chans) {
          const sid = c.nextSid++;
          const sub = { channel: ch, tickers: tickers && tickers.length ? new Set(tickers) : null, seq: 0 };
          c.subs.set(sid, sub);
          send(c, { id, type: 'subscribed', msg: { channel: ch, sid } });
          if (ch === 'orderbook_delta') for (const t of sub.tickers) snapshot(c, sid, sub, t);
        }
      } else if (m.cmd === 'unsubscribe') {
        const sids = Array.isArray(params.sids) ? params.sids : [];
        for (const sid of sids) { if (c.subs.delete(sid)) send(c, { id, type: 'unsubscribed', sid }); else err(c, id, 'unknown_sid', `unknown subscription id ${String(sid).slice(0, 20)}`); }
      } else if (m.cmd === 'update_subscription') {
        const sids = Array.isArray(params.sids) ? params.sids : params.sid != null ? [params.sid] : [];
        const tickers = tickersOf() || [];
        if (!['add_markets', 'delete_markets'].includes(params.action) || !sids.length) return err(c, id, 'params', 'params.sids and params.action (add_markets | delete_markets) required');
        for (const sid of sids) {
          const sub = c.subs.get(sid);
          if (!sub) { err(c, id, 'unknown_sid', `unknown subscription id ${String(sid).slice(0, 20)}`); continue; }
          if (!sub.tickers) sub.tickers = new Set();
          for (const t of tickers) {
            if (params.action === 'add_markets' && !sub.tickers.has(t)) { sub.tickers.add(t); if (sub.channel === 'orderbook_delta') snapshot(c, sid, sub, t); }
            if (params.action === 'delete_markets') sub.tickers.delete(t);
          }
          send(c, { id, type: 'ok', sid, seq: sub.seq, market_tickers: [...sub.tickers] });
        }
      } else if (m.cmd === 'list_subscriptions') {
        send(c, { id, type: 'ok', msg: { subscriptions: [...c.subs].map(([sid, x]) => ({ sid, channel: x.channel, market_tickers: x.tickers ? [...x.tickers] : [] })) } });
      } else err(c, id, 'unknown_cmd');
      return undefined;
    });
  });

  // ---------------------------------------------------------------- snapshots and deltas
  const lv = (map) => [...map.entries()].sort((a, z) => a[0] - z[0]).map(([p, n]) => [P.ccToDollars(p), ufp(n)]);
  function snapshot(c, sid, sub, t) {
    sub.seq += 1;
    if (c.product === 'perps') {
      if (!engine.perps) return;
      const msg = engine.perps.bookMsg(t);
      c.lastBooks.set(`${sid}:${t}`, msg);
      send(c, { type: 'orderbook_snapshot', sid, seq: sub.seq, msg });
      return;
    }
    const b = engine.book(t);
    send(c, { type: 'orderbook_snapshot', sid, seq: sub.seq, msg: { market_ticker: t, yes_dollars: lv(b.yes), no_dollars: lv(b.no) } });
  }
  function publish(product, channel, ticker, type, msg, onlyUser) {
    for (const c of clients) {
      if (c.product !== product) continue;
      if (onlyUser && c.user.id !== onlyUser) continue;
      for (const [sid, sb] of c.subs) {
        if (sb.channel !== channel) continue;
        if (ticker && sb.tickers && !sb.tickers.has(ticker)) continue;
        sb.seq += 1;
        send(c, { type, sid, seq: sb.seq, msg });
      }
    }
  }
  const on = (ev, fn) => engine.on(ev, (...a) => { if (!clients.size) return; try { fn(...a); } catch (e) { if (!/not open|closed/i.test(e.message)) console.error('trade ws', ev, e.message); } });
  // Predictions
  on('book_delta', (t, deltas) => { for (const d of deltas) publish('predictions', 'orderbook_delta', t, 'orderbook_delta', { market_ticker: t, side: d.side, price_dollars: P.ccToDollars(d.price), delta_fp: ufp(d.delta), ts: Date.now() }); });
  on('ticker', (t, q) => publish('predictions', 'ticker', t, 'ticker', { market_ticker: t, price_dollars: P.ccToDollars(q.last_price_cc), yes_bid_dollars: P.ccToDollars(q.yes_bid_cc), yes_ask_dollars: P.ccToDollars(q.yes_ask_cc), volume_fp: ufp(q.volume), open_interest_fp: ufp(q.open_interest), ts: Date.now() }));
  on('trade', (tr) => publish('predictions', 'trade', tr.market_ticker, 'trade', { trade_id: tr.trade_id, market_ticker: tr.market_ticker, yes_price_dollars: P.ccToDollars(tr.yes_price_cc), no_price_dollars: P.ccToDollars(P.CC - tr.yes_price_cc), count_fp: ufp(tr.count), taker_side: tr.taker_side, ts: tr.ts }));
  on('lifecycle', (t, eventType, status) => publish('predictions', 'market_lifecycle_v2', t, 'market_lifecycle_v2', { market_ticker: t, event_type: eventType, status, ts: Date.now() }));
  on('user_order', (uid, o) => publish('predictions', 'user_orders', o.market_ticker, 'user_order', tradeApi.orderV2(o), uid));
  on('fill', (uid, f) => {
    const action = db.prepare('SELECT action FROM orders WHERE id=?').get(f.order_id)?.action || 'buy';
    publish('predictions', 'fill', f.market_ticker, 'fill', { ...tradeApi.fillV2({ ...f, id: f.fill_id, created_ts: f.ts, action }), market_ticker: f.market_ticker }, uid);
    const x = db.prepare('SELECT * FROM positions WHERE user_id=? AND market_ticker=?').get(uid, f.market_ticker);
    if (x) publish('predictions', 'market_positions', f.market_ticker, 'market_position', { ticker: x.market_ticker, market_ticker: x.market_ticker, position_fp: ufp(x.yes_count > 0 ? x.yes_count : -x.no_count), side: x.yes_count > 0 ? 'yes' : x.no_count > 0 ? 'no' : null, market_exposure_dollars: dollars(x.yes_cost_cents + x.no_cost_cents), total_traded_dollars: dollars(x.yes_cost_cents + x.no_cost_cents), realized_pnl_dollars: dollars(x.realized_pnl_cents), fees_paid_dollars: dollars(x.fees_paid_cents), resting_orders_count: 0 }, uid);
  });
  on('api_order_group', (uid, g) => publish('predictions', 'order_group_updates', null, 'order_group_update', g, uid));
  // Perps
  on('perp_book', (t, msg) => {
    for (const c of clients) {
      if (c.product !== 'perps') continue;
      for (const [sid, sb] of c.subs) {
        if (sb.channel !== 'orderbook_delta' || (sb.tickers && !sb.tickers.has(t))) continue;
        const k = `${sid}:${t}`; const prev = c.lastBooks.get(k) || { bids: [], asks: [] };
        c.lastBooks.set(k, msg);
        for (const [side, key] of [['bid', 'bids'], ['ask', 'asks']]) {
          const a = new Map(prev[key].map(([p, n]) => [p, Number(n)])); const b = new Map(msg[key].map(([p, n]) => [p, Number(n)]));
          for (const pr of new Set([...a.keys(), ...b.keys()])) {
            const d = (b.get(pr) || 0) - (a.get(pr) || 0);
            if (Math.abs(d) < 0.005) continue;
            sb.seq += 1;
            send(c, { type: 'orderbook_delta', sid, seq: sb.seq, msg: { market_ticker: t, side, price: pr, delta_fp: d.toFixed(2), ts_ms: msg.ts_ms } });
          }
        }
      }
    }
  });
  on('perp_ticker', (t, msg) => publish('perps', 'ticker', t, 'ticker', msg));
  on('perp_trade', (t, msg) => publish('perps', 'trade', t, 'trade', msg));
  on('perp_order', (uid, o) => {
    publish('perps', 'user_orders', o.ticker, 'user_order', o, uid);
    for (const c of clients) {
      if (c.product !== 'perps' || c.user.id !== uid || ![...c.subs.values()].some((x) => x.channel === 'fill')) continue;
      for (const f of db.prepare('SELECT * FROM perp_fills WHERE order_id=? AND user_id=? ORDER BY created_ts').all(o.order_id, uid)) {
        if (c.sentFills.has(f.id)) continue;
        c.sentFills.add(f.id); if (c.sentFills.size > 5000) c.sentFills.clear();
        const msg = { fill_id: f.id, order_id: f.order_id, trade_id: f.trade_id, ticker: f.ticker, market_ticker: f.ticker, subaccount: f.subaccount, side: f.side, count: ufp(f.count), price: P.ccToDollars(f.price_cc), fees: P.ccToDollars(f.fee_cc), is_taker: !!f.is_taker, created_time: new Date(f.created_ts).toISOString(), ts_ms: f.created_ts };
        for (const [sid, sb] of c.subs) if (sb.channel === 'fill' && (!sb.tickers || sb.tickers.has(f.ticker))) { sb.seq += 1; send(c, { type: 'fill', sid, seq: sb.seq, msg }); }
      }
    }
  });
  on('perp_position', (uid, p) => publish('perps', 'market_positions', p.market_ticker, 'market_position', p, uid));
  on('perp_account', (uid, b) => publish('perps', 'account', null, 'account', b, uid));
  on('perp_event', (uid, type, msg) => { if (type === 'perp_order_group') publish('perps', 'order_group_updates', null, 'order_group_update', msg, uid); });

  // ---------------------------------------------------------------- revocation and heartbeat
  const closeKey = (keyId, reason) => { for (const c of [...clients]) if (c.key.id === keyId) endClient(c, reason); };
  apiKeys.events.on('revoked', (k, by) => closeKey(k.id, by === 'expired' ? 'key_expired' : 'key_revoked'));
  const iv = setInterval(() => {
    for (const c of [...clients]) {
      if (!c.alive) { c.misses += 1; if (c.misses >= 2) { clients.delete(c); try { c.ws.terminate(); } catch { /* ignore */ } continue; } }
      // Re-check the key and the owner: expiry, a lock, or the flag going off ends the session.
      try {
        const k = apiKeys.getKey(c.key.id);
        if (!k || apiKeys.effectiveStatus(k) !== 'active') { endClient(c, 'key_revoked'); continue; }
        if (apiKeys.blockedReason(c.user.id)) { endClient(c, 'account_unavailable'); continue; }
        if (!flags.on('api.ws', { uid: c.user.id })) { endClient(c, 'feature_disabled'); continue; }
      } catch { /* db closing */ }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  iv.unref?.();
  return { handleUpgrade, clients, close: () => { clearInterval(iv); for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } } wss.close(); }, sessions: () => [...clients].map((c) => ({ key_id: c.key.id, user_id: c.user.id, product: c.product, subscriptions: c.subs.size })) };
}

module.exports = { attachTradeWs, CHANNELS, PATHS, declareChannels };

'use strict';
// Data retention by class (Phase 9A not-built item, 2026-11-13; CLONE_SPEC.md §39.19), real server + SQLite + Chromium:
//   • the recommended defaults purge in-app notifications after 365 days, device sightings after 180, share-link click
//     records after 90 and copies of sent emails after 30, and keep event chat (0 = keep forever); newer rows stay;
//   • every class purged is audited with its count; Admin › System reports the classes and the last purge;
//   • Admin › Owner settings shows the "Data retention" group; a change in the UI (chat kept 30 days) takes effect on the
//     next purge and survives a restart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { Client } = require('./lib/client');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parlance-retention-'));
const DB_FILE = path.join(TMP, 'retention.db');
const PW = 'Ogun-Lantern-Ferry-4471';
const stamp = Date.now();
const ADMIN = { email: `root.${stamp}@example.test`, password: PW };
const HIGH = { burst: 1e6, per_second: 1e6 };
const OPTS = { port: 0, dbFile: DB_FILE, quiet: true, sports: false, tickMs: 500, admin: ADMIN, rate: { burst: 1e6, perSec: 1e6 }, security: { challengeMode: 'off', authRate: HIGH, writeRate: HIGH } };
const DAY = 86400000;
let srv; let BASE; let browser; let member;
const dbq = (sql, ...a) => { const d = new DatabaseSync(DB_FILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const count = (sql, ...a) => dbq(sql, ...a)[0].c;

before(async () => {
  srv = await start(OPTS);
  BASE = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
  member = await new Client(BASE, 'm').signUp(`ret.${stamp}@example.test`, PW, 'Retention Member');
});
after(async () => {
  try { await browser?.close(); } catch { /* closed */ }
  try { await srv?.close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// One old (just past the default) and one recent row in every class.
function seed(tag) {
  const d = srv.db; const uid = member.user.user_id; const now = Date.now();
  const at = (days) => now - days * DAY;
  for (const [age, k] of [[400, 'old'], [10, 'new']]) d.prepare('INSERT INTO notifications(id,user_id,type,title,body,link,created_ts) VALUES(?,?,?,?,?,?,?)').run(`nt_${tag}_${k}`, uid, 'account', 't', 'b', '', at(age));
  for (const [age, k] of [[200, 'old'], [10, 'new']]) d.prepare('INSERT INTO device_sightings(device_hash,user_id,ua_hash,first_seen,last_seen,count) VALUES(?,?,?,?,?,1)').run(`dev_${tag}_${k}`, uid, '', at(age), at(age));
  for (const [age] of [[100], [10]]) d.prepare('INSERT INTO share_clicks(link_id,ts,ip_hash,counted) VALUES(?,?,?,1)').run(`lnk_${tag}`, at(age), 'h');
  for (const [age, k] of [[40, 'old'], [5, 'new']]) d.prepare('INSERT INTO email_outbox(id,user_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(`em_${tag}_${k}`, uid, 'x@example.test', 's', 'b', new Date(at(age)).toISOString());
  for (const [age, k] of [[60, 'old'], [5, 'new']]) d.prepare('INSERT INTO chat_messages(id,room,user_id,nickname,body,reply_to,created_ts) VALUES(?,?,?,?,?,?,?)').run(`ch_${tag}_${k}`, 'event:TEST', uid, 'ret', 'hello', null, at(age));
}

test('recommended defaults: old notifications, device sightings, share clicks and email copies go; chat is kept; newer rows stay; audited', async () => {
  seed('a');
  const removed = await srv.app.locals.ops.purgeData();
  assert.deepEqual(Object.keys(removed).sort(), ['device_sightings', 'email_outbox', 'notifications', 'share_clicks']);
  assert.equal(count("SELECT COUNT(*) c FROM notifications WHERE id LIKE 'nt_a_%'"), 1);
  assert.equal(count("SELECT COUNT(*) c FROM notifications WHERE id='nt_a_new'"), 1);
  assert.equal(count("SELECT COUNT(*) c FROM device_sightings WHERE device_hash='dev_a_new'"), 1);
  assert.equal(count("SELECT COUNT(*) c FROM device_sightings WHERE device_hash='dev_a_old'"), 0);
  assert.equal(count("SELECT COUNT(*) c FROM share_clicks WHERE link_id='lnk_a'"), 1);
  assert.equal(count("SELECT COUNT(*) c FROM email_outbox WHERE id LIKE 'em_a_%'"), 1);
  assert.equal(count("SELECT COUNT(*) c FROM chat_messages WHERE id LIKE 'ch_a_%'"), 2, 'chat is kept by default (0 = forever)');
  for (const t of ['notifications', 'device_sightings', 'share_clicks', 'email_outbox']) {
    const row = dbq("SELECT after_json FROM admin_audit WHERE action='ops.retention_purge' AND target_id=?", t)[0];
    assert.ok(row && JSON.parse(row.after_json).rows >= 1, `${t} purge audited`);
  }
  const sys = srv.app.locals.ops.retentionVo();
  assert.equal(sys.classes.find((c) => c.key === 'retention.chat_days').days, 0);
  assert.ok(sys.last && sys.last.removed.notifications >= 1);
});

test('Admin › Owner settings: the Data retention group; chat kept 30 days from the UI purges older chat on the next run; kept after a restart', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ap = await ctx.newPage();
  const errors = []; ap.on('pageerror', (e) => errors.push(e.message));
  await ap.goto(BASE + '/sign-in');
  await ap.fill('input[name=email]', ADMIN.email);
  await ap.fill('input[name=password]', PW);
  await ap.click('button[type=submit]');
  await ap.waitForSelector('[data-testid=account-menu]');
  await ap.goto(BASE + '/admin/owner_settings');
  const group = ap.locator('[data-testid=owner-group][data-group=retention]');
  await group.waitFor();
  assert.match(await group.textContent(), /Data retention/);
  for (const k of ['notifications_days', 'device_days', 'share_clicks_days', 'email_copies_days', 'chat_days']) assert.equal(await group.locator(`[data-key="retention.${k}"]`).count(), 1, k);
  await ap.click('[data-testid=owner-setting][data-key="retention.chat_days"] [data-testid=owner-edit]');
  await ap.waitForSelector('[data-testid=owner-form]');
  await ap.fill('[data-testid=owner-form] [name=value]', '30');
  await ap.fill('[data-testid=owner-form] [name=reason]', 'chat older than a month is not needed');
  await ap.click('[data-testid=owner-form] button[type=submit]');
  const which = await Promise.race([
    ap.waitForSelector('[data-testid=step-up-password]', { timeout: 15000 }).then(() => 'step_up').catch(() => null),
    ap.waitForSelector('[data-testid=owner-setting][data-key="retention.chat_days"][data-value="30"]', { timeout: 15000 }).then(() => 'done').catch(() => null),
  ]);
  if (which === 'step_up') { await ap.fill('[data-testid=step-up-password]', PW); await ap.click('[data-testid=step-up-submit]'); }
  await ap.waitForSelector('[data-testid=owner-setting][data-key="retention.chat_days"][data-value="30"]');
  seed('b');
  await srv.app.locals.ops.purgeData();
  assert.equal(count("SELECT COUNT(*) c FROM chat_messages WHERE id='ch_b_old'"), 0, 'chat older than 30 days goes');
  assert.equal(count("SELECT COUNT(*) c FROM chat_messages WHERE id='ch_b_new'"), 1, 'newer chat stays');
  assert.deepEqual(errors, []);
  await ctx.close();
  await srv.close();
  srv = await start(OPTS);
  assert.equal(srv.app.locals.ops.retentionVo().classes.find((c) => c.key === 'retention.chat_days').days, 30, 'kept after a restart');
});

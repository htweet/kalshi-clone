'use strict';
// Server-side wording of Phase 9A (CLONE_SPEC.md §39): operating switches, Admin › System, Launch readiness, alerts and
// their test messages. Keyed templates with named variables; Admin › Content › Texts overrides them as
// `server.ops.<key>` (server/cms/texts.js lists this module).
const catalog = require('./catalog');

const STRINGS = {
  // ---- operating switches (API errors and the reasons they give)
  'error.maintenance': 'Parlance is down for scheduled maintenance. Please try again shortly.',
  'error.maintenance_details': 'Writes are paused while maintenance is in progress; reading still works.',
  'error.read_only': 'Parlance is in read-only mode while the team works on the database. Changes are not possible right now.',
  'error.trading_halted': 'Trading is halted across the exchange. You can still cancel resting orders.',
  'error.launch_not_ready': 'Launch readiness is not complete, so the switch to real money is refused.',
  'error.two_person': 'Resuming trading needs a second admin: a request was created for another admin to approve.',
  'error.same_admin': 'A different admin must approve this request.',
  'error.rotation_manual': 'This deployment reads its keys from the environment or a read-only secrets file. Run `npm run keys -- rotate --file <keyring>` on the server and restart.',
  'error.admin_ip': 'This address is not on the admin allowlist.',
  'error.lockout': 'The new allowlist does not include the address you are using now ({ip}); saving it would lock you out.',
  // ---- alerts
  'alert.test.subject': 'Parlance alert test',
  'alert.test.body': 'This is a test of the Parlance alert channel. To confirm this contact, enter the code {code} in Admin › System › Alerts within 30 minutes.',
  'alert.firing.subject': '[Parlance] ALERT: {rule}',
  'alert.firing.body': 'Alert: {rule}\nSince: {time}\nDetails: {detail}\n\nOpen Admin › System for the current state. The incident runbook is docs/runbooks/incident-response.md.',
  'alert.resolved.subject': '[Parlance] Resolved: {rule}',
  'alert.resolved.body': 'Resolved: {rule}\nAt: {time}\nLast details: {detail}',
  'alert.rule.backup_overdue': 'Backup overdue',
  'alert.rule.restore_drill_overdue': 'Restore drill overdue',
  'alert.rule.anchor_overdue': 'Audit-chain anchor overdue',
  'alert.rule.verifier_failure': 'Ledger, journal or audit-chain verifier failed',
  'alert.rule.error_rate': 'Error rate high',
  'alert.rule.order_latency': 'Order latency high',
  'alert.rule.job_stalled': 'Background job stalled',
  'alert.rule.disk_filling': 'Disk filling up',
  'alert.rule.cert_expiry': 'TLS certificate expiring',
  // ---- Launch readiness: automatic checks
  'check.config_guard': 'Production configuration',
  'check.config_guard.help': 'Every production setting is in place: allowed origins, admin origin, scrypt cost, keys outside the data folder, demo accounts and simulators off, Secure cookies, trusted proxy ranges, off-site backups.',
  'check.tls_hsts': 'TLS and HSTS',
  'check.tls_hsts.help': 'The public origin is https, HSTS is sent, and requests arrive over HTTPS through the trusted proxy.',
  'check.admin_origin': 'Separate admin origin',
  'check.admin_origin.help': 'The admin panel answers only on its own https origin with its own cookie.',
  'check.backups_fresh': 'Backups fresh',
  'check.backups_fresh.help': 'The newest encrypted backup is younger than the backup-age setting, and WAL shipping is running.',
  'check.backups_offsite': 'Backups off the server',
  'check.backups_offsite.help': 'Backups go to an S3-compatible bucket (or a folder on another disk), not the data volume.',
  'check.db_durability': 'Maximum durability on',
  'check.db_durability.help': 'Admin › Owner settings › Maximum durability is on: every commit waits for the disk, so a power cut cannot lose confirmed trades or payments. Required before real money.',
  'check.restore_drill': 'Restore drill recent',
  'check.restore_drill.help': 'A restore drill succeeded within the drill-age setting: the newest backup was restored and every verifier passed.',
  'check.alerts_contact': 'Alerts reach a confirmed contact',
  'check.alerts_contact.help': 'At least one alert contact is confirmed (a test was received and its code entered) and alert delivery is on.',
  'check.key_ages': 'Key ages',
  'check.key_ages.help': 'The active master key is younger than the key-age setting and no value is waiting to be re-encrypted.',
  'check.audit_anchor': 'Audit anchor recent',
  'check.audit_anchor.help': 'The audit chain was anchored within two anchor intervals and still contains the anchored head.',
  'check.dependency_scan': 'Dependency scan clean',
  'check.dependency_scan.help': 'An npm audit result with no high or critical findings, recorded within the last 30 days.',
  'check.image_scan': 'Container image scan clean',
  'check.image_scan.help': 'A Trivy scan of the release image with no high or critical findings, recorded within the last 30 days.',
  'check.load_test': 'Load test within targets',
  'check.load_test.help': 'A load-test report within the targets (orders per second, order p99, WebSocket fan-out p99, public page p95), recorded within the last 30 days.',
  'check.flags_launch': 'Switches in their launch state',
  'check.flags_launch.help': 'Maintenance, read-only and the trading halt are off; the results simulator is off; backups and alerts are on.',
  // ---- Launch readiness: owner items
  'item.pen_test': 'External penetration test done and findings closed',
  'item.terms_privacy': 'Terms of service and privacy policy reviewed by counsel',
  'item.ndpa': 'NDPA registration with the NDPC and a data-protection officer named',
  'item.support': 'Support hours and contacts published',
  'item.incident_contacts': 'Incident contacts and escalation list agreed',
  // ---- audit reasons used by jobs
  'reason.retention': 'retention (owner setting)',
};

const s = catalog.scoped('server.ops.', STRINGS);
module.exports = { STRINGS, s };

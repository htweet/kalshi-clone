# Incident response

Runbook for Parlance Exchange in production (PLAN P9.6, CLONE_SPEC.md §39.10). Keep a printed copy with the incident
contacts; the admin panel may be the thing that is down.

## Severity levels

| Level | Meaning | Examples | Response |
|---|---|---|---|
| **SEV1** | Money or personal data at risk, or the exchange is down for everyone | ledger / journal / audit-chain verifier failing; suspected breach; database lost; site down > 5 min | Page the on-call owner and the engineer now, day or night. Trading halt within 15 minutes if money could move wrongly. |
| **SEV2** | A core function is broken for many members | orders failing; WebSocket down; deposits stuck; backups or WAL shipping stopped > 1 h | Engineer within 30 minutes in support hours, 1 hour outside. |
| **SEV3** | Degraded or a single feature broken | slow pages; one market feed stale; an outbox backing up | Next working day. |

Alerts arrive by email and on the owner's phone (Alertmanager, and the app's own alerts to the contacts confirmed in
Admin › System › Alerts). Every alert names its rule; the rules are in `deploy/prometheus/alerts.yml` and §39.5.

## Who is called

Fill in and keep current (the Launch readiness item "Incident contacts and escalation list agreed" refers to this list):

| Role | Name | Phone | Email | Backup |
|---|---|---|---|---|
| Incident lead (owner) | `<name>` | `<phone>` | `<email>` | `<name>` |
| Engineer on call | `<name>` | `<phone>` | `<email>` | `<name>` |
| Hosting provider support | `<provider>` | `<phone>` | `<portal>` | — |
| Data-protection officer (NDPA) | `<name>` | `<phone>` | `<email>` | — |
| Legal counsel | `<name>` | `<phone>` | `<email>` | — |

## The first 15 minutes

1. **Acknowledge** the alert (reply in the alert channel) so nobody else starts the same work. Write down the time.
2. **Assess** with Admin › System (health, verifiers, backups, firing alerts) and Grafana (`/grafana` on the admin host:
   error rate, order latency, job ages, disk). If the admin host is down, use `docker compose ps` and
   `docker compose logs --since 15m app` on the VM.
3. **Contain** — choose the smallest switch that stops harm (Admin › System › Operating switches; every change needs a
   reason and is audited):
   - money could move wrongly, or matching misbehaves → **Exchange-wide trading halt** (resuming needs a second admin);
   - data is being changed wrongly, or you are about to restore → **Read-only mode**;
   - members should be told to wait while you work → **Maintenance mode** (staff keep access);
   - a single feature is the cause → switch its feature flag off (Admin › Feature flags).
4. **Communicate** (templates below): status page incident (Admin › API keys › Status incidents), in-app banner (the
   switches show theirs automatically), email to affected members if their money or data is involved.
5. **Preserve evidence** before changing anything else (see Forensics).

## Communication templates (CMS)

The wording lives in the CMS so it can be adjusted without a deploy: the status-page incident is a CMS entry of type
`incident`; the switch banners are the texts `flags.ops.*`; the maintenance and halt API messages are `server.ops.error.*`
(Admin › Content › Texts). Suggested first incident text:

> **Investigating** — We are looking into <what members see> since <time WAT>. <Trading is halted / Deposits are paused>
> while we do; your balances and positions are safe. Next update by <time>.

Updates at least every 30 minutes for SEV1, hourly for SEV2. The resolution note says what happened, what members need to
do (usually nothing), and when the review will be published.

## Forensics (preserve before you fix)

1. Take a **manual backup** (Admin › System › Back up now, reason "incident <id>") — an encrypted, checksummed copy in the
   backup store, outside the server.
2. Export the logs of the incident window from Loki (Grafana › Explore) and save them with the incident record; the app's
   lines are scrubbed of personal data and carry request ids.
3. Record the **audit-chain anchor** and verifier results (Admin › System › Verify now). A failing anchor comparison means
   the database was rewritten: treat it as SEV1 and do not trust admin history until restored and compared.
4. Do not reboot or rebuild the VM before the disk is snapshotted at the hosting provider when a breach is suspected.
5. For a personal-data breach: inform the data-protection officer at once; the NDPA requires notifying the NDPC within
   72 hours of becoming aware of a breach likely to risk members' rights.

## Recovery

- Code or configuration problem: roll back to the previous image (README › Deployment › Rollback).
- Data problem: restore to the moment before it (docs/runbooks/restore.md); verify; then lift read-only mode.
- Key compromise: rotate the master key (docs/runbooks/rotate-keys.md) and every secret listed there; sign everyone out.

## Post-incident review

Within 5 working days for SEV1 / SEV2: timeline, impact (members, money, data), root cause, what went well, what did not,
actions with owners and dates. Blameless. Link it from the status-page incident when it concerns members.

## Routine (keeps incidents rare)

- Dependencies: Dependabot opens weekly updates (npm, GitHub Actions, base images); **security fixes within 7 days**
  (high / critical within 48 hours). CI fails on high / critical findings in `npm audit` and the image scan (Trivy).
- **Quarterly access review** of admin roles (Admin › Roles): remove leavers, check every `settings.write` and money role,
  record the review in the audit log (reason "quarterly access review <quarter>").
- Restore drill: automatic weekly in the app (owner setting), and the backup sidecar verifies every 6 hours; Admin › System
  shows the last success. A monthly manual drill to a separate machine is recommended (restore.md).

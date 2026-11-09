# Restore and restore drills

Runbook (PLAN P9.2, CLONE_SPEC.md §39.3). Backups are encrypted with the **backup key** (`deploy/secrets/backup.key`, a
copy kept off the server by the owner). Without it nothing can be restored.

## What exists

- **Snapshots**: every 15 minutes (owner setting), a nightly full copy at 02:00 WAT, one before the switch to real money,
  and manual ones — each sealed with AES-256-GCM, checksummed, in the backup store (`BACKUP_STORAGE`: an S3-compatible
  bucket, or a local folder on another disk until the provider is chosen).
- **WAL segments**: every database change shipped every 10 seconds (owner setting) — the loss window.
- **Retention**: interval snapshots 48 h; nightly 7 daily / 4 weekly / 12 monthly (owner settings); WAL back to the
  oldest kept snapshot. Pre-production and manual snapshots a year.

## Restore to a moment (one command)

```sh
# 1. Stop writes. Ideally switch on read-only mode in Admin › System, then stop the app:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop app
# 2. See what is there (snapshots and WAL generations with their times):
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm --no-deps app node scripts/restore.js --list
# 3. Restore to a time (UTC, ISO 8601) — or --to now — over the database, with the verifiers:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm --no-deps app \
  node scripts/restore.js --to 2026-11-09T14:05:00Z --out /data/parlance.db --force --verify
# 4. Start again, check Admin › System (verifiers green), then switch read-only mode off.
docker compose -f deploy/docker-compose.yml --env-file deploy/.env start app
```

Outside Docker: `npm run restore -- --to <time> --out data/parlance.db --force --verify` with `BACKUP_STORAGE`,
`BACKUP_KEY(_FILE)` and the master key in the environment. The command refuses to write over a database a running server
holds. `--verify` runs integrity, ledger / journal and audit-chain checks; a failure exits non-zero.

The result says which snapshot it started from, how many WAL segments it applied and the time it reached (the newest
shipped commit at or before the asked time).

## Restore drills

- **In the app**: Admin › System › Run a restore drill restores the newest backup plus WAL into a temporary file and runs
  every verifier; automatic every 7 days (owner setting `backups.drill_every_days`); the alert fires after 30 days without
  a successful drill (`backups.drill_max_age_days`).
- **Sidecar**: the `backup` service restores from the store alone every 6 hours (`parlance_backup_verify_ok`).
- **Monthly, by hand** (recommended): restore to a scratch machine with only the backup key and the key ring, start the
  server on it, sign in, look around. This proves the keys held off the server are the right ones.

## Staging copy without personal data

Staging gets production's structure and markets, not its members' data:

1. Restore the newest snapshot to a scratch file (`--out /tmp/staging.db`) on the staging host.
2. Start the staging server on it with **staging's own key ring** — encrypted personal fields (identity data, TOTP secrets,
   waitlist emails) cannot be read with another key, and the import step below removes them anyway.
3. Run in a SQLite shell on the copy, before the first start:
   `DELETE FROM identity_profiles; DELETE FROM identity_keys; DELETE FROM docv_documents; DELETE FROM kyc_jobs;
   DELETE FROM waitlist_entries; DELETE FROM email_outbox; DELETE FROM sms_outbox; DELETE FROM sessions;
   UPDATE users SET email = 'user-' || substr(id, 1, 8) || '@staging.example.test', password_hash = '!staging';`
4. Create staging's own admin (`npm run create-admin`).

## When the database file is damaged but the server is up

Prefer **restore to now** over repair: switch on read-only, take a manual backup (it ships the latest WAL), stop, restore
with `--to now`, verify, start, lift read-only.

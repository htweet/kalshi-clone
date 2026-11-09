# Rotating keys and secrets

Runbook (PLAN P9.6, RS4; CLONE_SPEC.md §39.10). Rotate the master key yearly (owner setting `keys.max_age_days`, Launch
readiness shows the age), and at once after a suspected leak.

## Master key ring (field encryption, audit chain, signed tokens)

The ring is `deploy/secrets/keyring.json` (mounted as `SECRET_KEYRING_FILE`). Each key has an id (`k1`, `k2`, …); the
`active` one encrypts new values, every key in the ring can still decrypt the values that name it.

```sh
# On the VM, with the stack running:
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm --no-deps \
  -v "$PWD/deploy/secrets:/secrets" app node scripts/keys.js rotate --file /secrets/keyring.json
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d app   # restart reads the new ring
```

On start the server sees values under the old key, **re-encrypts** them in the background (TOTP secrets, identity key
wrapping, waitlist emails, push keys, OAuth material, alert contacts, the heist codes, the SMS outbox), **verifies**
every value decrypts under the new key, and marks the old key **retired**. Admin › System › Keys shows the progress, the
key ages and the counts. In development (`data/secret.key`) the same is one click: Admin › System › Rotate.

The retired key **stays in the ring** while it is needed to verify history: audit-chain rows sealed before the rotation,
and the keyed lookup hashes (phone, national id, waitlist email, device and IP hashes, share links) that are derived from
the ring's `hmac` key. Admin › System marks a key "removable" once nothing needs it; only then delete it from the file.
Copy the new keyring.json to the owner's safe.

## Backup key

1. `docker compose … run --rm --no-deps app node scripts/keys.js backup-key > deploy/secrets/backup.key.new`
2. Move the current key to `BACKUP_KEY_PREVIOUS` (or keep it as a second secret), install the new one as
   `deploy/secrets/backup.key`, restart. New backups use the new key; older ones still open with the previous key.
3. After the oldest backup sealed with the old key has aged out of retention (12 months for monthly copies), remove
   `BACKUP_KEY_PREVIOUS`. Keep both keys in the safe until then.

## Other secrets

| Secret | Where | How to rotate |
|---|---|---|
| Session cookies | database (`sessions`) | Admin › Users or `revokeAll` per user; a global sign-out is `DELETE FROM sessions` during maintenance |
| VAPID (Web Push) keys | database, encrypted with the master key | rotate the master key; a new VAPID pair needs every browser to resubscribe (Admin › System in a later phase) |
| Payment webhook signing keys | derived from the master key | follow the master key; providers' own secrets per provider dashboard (9C) |
| SMTP / S3 credentials | `deploy/.env` | create the new credential at the provider, update `.env`, `docker compose up -d`, revoke the old one |
| Grafana admin password | `deploy/secrets/grafana_admin_password` | write a new one, `docker compose up -d grafana` |
| Alertmanager SMTP password | `deploy/.env` | as SMTP |
| `METRICS_TOKEN` (optional) | `deploy/.env` and Prometheus | change both, restart both |

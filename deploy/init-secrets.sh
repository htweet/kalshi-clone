#!/bin/sh
# Creates the secrets the stack reads (deploy/docker-compose.yml `secrets:`), once, outside the data volume:
#   deploy/secrets/keyring.json              the master key ring (k1), mode 0600
#   deploy/secrets/backup.key                the backup encryption key, mode 0600
#   deploy/secrets/grafana_admin_password    Grafana's admin password
# Copy keyring.json and backup.key to the owner's password manager or safe NOW: without them, backups cannot be opened.
# Never commit deploy/secrets/ (git-ignored). Rotation: docs/runbooks/rotate-keys.md.
set -eu
cd "$(dirname "$0")"
mkdir -p secrets
chmod 700 secrets
umask 077
if [ ! -f secrets/keyring.json ]; then
  k1=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  printf '{"active":"k1","hmac":"k1","keys":{"k1":"%s"},"created":{"k1":"%s"}}\n' "$k1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > secrets/keyring.json
  echo "wrote secrets/keyring.json"
fi
if [ ! -f secrets/backup.key ]; then
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > secrets/backup.key
  echo "wrote secrets/backup.key"
fi
if [ ! -f secrets/grafana_admin_password ]; then
  od -An -tx1 -N18 /dev/urandom | tr -d ' \n' > secrets/grafana_admin_password
  echo "wrote secrets/grafana_admin_password"
fi
echo "Store keyring.json and backup.key off this server before going further."

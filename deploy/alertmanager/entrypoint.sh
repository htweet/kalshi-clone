#!/bin/sh
# Alertmanager start-up (CLONE_SPEC.md §39.5). Alertmanager cannot read environment variables in its configuration, so
# this script writes the configuration from them, then starts it:
#   - email to ALERT_EMAIL through ALERT_SMTP_HOST (host:port), ALERT_SMTP_FROM, ALERT_SMTP_USER, ALERT_SMTP_PASSWORD —
#     only when ALERT_SMTP_HOST and ALERT_EMAIL are set (before email is configured Alertmanager still starts);
#   - critical alerts also to the phone webhook ALERT_PHONE_WEBHOOK (an SMS gateway, a push service such as ntfy, or a
#     chat app; the provider is the owner's choice).
# Every value is written as a quoted YAML string, so quotes or backslashes in a password cannot change the file.
set -eu
q() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
OUT=/tmp/alertmanager.yml
EMAIL="${ALERT_EMAIL:-}"; SMTP="${ALERT_SMTP_HOST:-}"; HOOK="${ALERT_PHONE_WEBHOOK:-}"
mail=0; [ -n "$EMAIL" ] && [ -n "$SMTP" ] && mail=1
{
  if [ "$mail" = 1 ]; then
    echo "global:"
    echo "  smtp_smarthost: $(q "$SMTP")"
    echo "  smtp_from: $(q "${ALERT_SMTP_FROM:-$EMAIL}")"
    [ -n "${ALERT_SMTP_USER:-}" ] && echo "  smtp_auth_username: $(q "$ALERT_SMTP_USER")"
    [ -n "${ALERT_SMTP_PASSWORD:-}" ] && echo "  smtp_auth_password: $(q "$ALERT_SMTP_PASSWORD")"
    echo "  smtp_require_tls: true"
  fi
  cat <<'EOF'
route:
  receiver: owner
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 1h
  routes:
    - matchers: [severity="critical"]
      receiver: owner-phone-and-email
      repeat_interval: 30m
receivers:
  - name: owner
EOF
  if [ "$mail" = 1 ]; then
    echo "    email_configs:"
    echo "      - to: $(q "$EMAIL")"
    echo "        send_resolved: true"
  fi
  echo "  - name: owner-phone-and-email"
  if [ "$mail" = 1 ]; then
    echo "    email_configs:"
    echo "      - to: $(q "$EMAIL")"
    echo "        send_resolved: true"
  fi
  if [ -n "$HOOK" ]; then
    echo "    webhook_configs:"
    echo "      - url: $(q "$HOOK")"
    echo "        send_resolved: true"
  fi
} > "$OUT"
[ "$mail" = 1 ] || echo "alertmanager: ALERT_EMAIL / ALERT_SMTP_HOST not set; email alerts are off until they are" >&2
[ -n "$HOOK" ] || echo "alertmanager: ALERT_PHONE_WEBHOOK not set; phone alerts are off until it is" >&2
exec /bin/alertmanager --config.file="$OUT" --storage.path=/alertmanager "$@"

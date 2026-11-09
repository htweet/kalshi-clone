# Putting Cloudflare in front

Runbook (PLAN P9.3, owner decision 2026-11-09: Cloudflare in front; CLONE_SPEC.md §39.6). Nothing in the code depends on
Cloudflare: the trusted address ranges are configuration, and any CDN / WAF in proxy mode works the same way.

## 1. DNS and proxy

1. Add the domain to Cloudflare (Free or Pro plan). Create `A` records for the site host and the admin host pointing at
   the VM, **proxied** (orange cloud). Lagos is served from Cloudflare's Lagos point of presence.
2. SSL/TLS mode **Full (strict)**: Caddy already holds a valid certificate for both hosts.
3. Edge certificates: Always Use HTTPS on, minimum TLS 1.2, HSTS is sent by the origin (do not enable it twice with
   different values).

## 2. Tell the origin which addresses are Cloudflare

Put Cloudflare's published ranges (https://www.cloudflare.com/ips/) in `deploy/.env`, space-separated:

```
CLOUDFLARE_IPS=173.245.48.0/20 103.21.244.0/22 … 2400:cb00::/32 …
```

Caddy then takes the visitor's address from `CF-Connecting-IP` only when the request really came from Cloudflare; the app
trusts only Caddy (`TRUST_PROXY`). A visitor who forges `X-Forwarded-For` or `CF-Connecting-IP` reaching the origin any
other way gets their real address used (rate limits, geo rules and audit stay correct).

## 3. Lock the origin to Cloudflare

- **Firewall**: on the VM (or the provider's firewall), allow ports 80/443 only from Cloudflare's ranges; 9443 (FIX over
  TLS) from the API clients' addresses only (Cloudflare does not proxy raw TCP on Free/Pro); SSH from the owner's address.
- **Authenticated origin pulls** (recommended): enable it in Cloudflare › SSL/TLS › Origin Server, download Cloudflare's
  origin-pull CA to `deploy/caddy/cloudflare-origin-pull-ca.pem`, and uncomment the `tls { client_auth … }` block for the
  site host in `deploy/caddy/Caddyfile`. Requests that do not come through Cloudflare are then refused at the TLS layer.

## 4. Caching and bots

- Cache only the hashed assets (`/assets/*`, immutable) and the public share images (`/og/*`). A Cache Rule "Bypass cache"
  for everything else — the origin already sends `Cache-Control: no-store` on personal responses.
- WAF: Cloudflare Managed Ruleset on; OWASP core ruleset in log mode first, then block after a week of clean logs.
- **Bot Fight Mode off for `/v1/*`, `/trade-api/*` and the WebSocket** (a Configuration Rule): the app's own browser
  check, client tokens and rate limits stay the source of truth, and API clients would otherwise be challenged.
- DDoS protection is on by default.

## 5. Check

- `curl -sI https://<site>/healthz` through Cloudflare: `cf-ray` header present, 200.
- From another network, `curl -sk --resolve <site>:443:<VM IP> https://<site>/healthz` must fail (origin locked).
- Admin › Launch readiness › "TLS and HSTS" is green; a sign-in from a phone shows the phone's network in
  Account › Security (not Cloudflare's address).

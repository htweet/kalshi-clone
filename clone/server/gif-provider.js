'use strict';
// Optional external GIF provider adapter (PLAN P2.2, PHASE2_SPEC.md §24.3). DISABLED by default: Parlance ships with its
// own moderated sticker set and no third-party key. When an operator configures a provider, every request goes through
// the server (the browser never talks to the provider and never receives a provider URL it can follow):
//   - one allowlisted HTTPS host per provider for the search API and one for media; any other host is refused;
//   - a content-rating filter (default 'g'; only results at or below the configured rating are returned);
//   - result ids are opaque provider ids validated against a strict pattern; media is fetched by the server and
//     re-served from /v1/social/gifs/media/<id> (same origin, so the page CSP needs no third-party img-src);
//   - responses are size-capped and content-type checked (image/gif or image/webp only).
// Configuration (environment): GIF_PROVIDER (name), GIF_API_KEY, GIF_API_HOST, GIF_MEDIA_HOST, GIF_RATING.
// Without all of them the adapter reports { enabled: false } and the routes answer 503 gif_provider_disabled.
const RATINGS = ['g', 'pg', 'pg-13', 'r'];
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

const ratingAllowed = (item, max) => RATINGS.indexOf(String(item || '').toLowerCase()) !== -1 && RATINGS.indexOf(String(item).toLowerCase()) <= RATINGS.indexOf(max);

// A URL is allowed only when it is https on exactly the allowlisted host (no userinfo, no port, no IP literal tricks).
function hostAllowed(raw, host) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.hostname === host;
  } catch { return false; }
}

function createGifProvider(env = process.env) {
  const cfg = { name: env.GIF_PROVIDER || '', key: env.GIF_API_KEY || '', apiHost: env.GIF_API_HOST || '', mediaHost: env.GIF_MEDIA_HOST || '', rating: RATINGS.includes(String(env.GIF_RATING || 'g').toLowerCase()) ? String(env.GIF_RATING || 'g').toLowerCase() : 'g' };
  const enabled = !!(cfg.name && cfg.key && cfg.apiHost && cfg.mediaHost);
  const status = () => ({ enabled, provider: enabled ? cfg.name : null, rating: cfg.rating });

  // The provider-specific mapping is the only part an operator would add; the shape below is the contract:
  // search(q) -> [{ id, rating, media_url }] where media_url must be on GIF_MEDIA_HOST.
  async function search(q, { limit = 12, fetchImpl = globalThis.fetch } = {}) {
    if (!enabled) return null;
    const url = new URL(`https://${cfg.apiHost}/v1/search`);
    url.searchParams.set('q', String(q).slice(0, 50));
    url.searchParams.set('limit', String(Math.min(25, Math.max(1, limit))));
    url.searchParams.set('rating', cfg.rating);
    if (!hostAllowed(url.href, cfg.apiHost)) return [];
    const r = await fetchImpl(url, { headers: { authorization: `Bearer ${cfg.key}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (Array.isArray(j && j.results) ? j.results : [])
      .filter((x) => x && ID_RE.test(String(x.id)) && ratingAllowed(x.rating, cfg.rating) && hostAllowed(x.media_url, cfg.mediaHost))
      .slice(0, limit)
      .map((x) => ({ id: String(x.id), rating: String(x.rating).toLowerCase(), url: `/v1/social/gifs/media/${encodeURIComponent(x.id)}`, _media: x.media_url }));
  }

  async function media(url, { fetchImpl = globalThis.fetch } = {}) {
    if (!enabled || !hostAllowed(url, cfg.mediaHost)) return null;
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(4000) });
    const type = String(r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !['image/gif', 'image/webp'].includes(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > MAX_MEDIA_BYTES ? null : { type, body: buf };
  }

  return { status, search, media, enabled };
}

module.exports = { createGifProvider, hostAllowed, ratingAllowed, RATINGS };

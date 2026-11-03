'use strict';
// Parlance's self-hosted sticker set (PLAN P2.2, PHASE2_SPEC.md §24.3). Every sticker below is original art drawn for
// Parlance as plain SVG shapes: no third-party artwork, fonts, scripts, <style> elements, event handlers or external
// references. Stickers are served by GET /v1/social/stickers/<id>.svg from this table only (never from a URL a user
// supplies); posts, replies and chat messages store the sticker id. Admins can switch individual stickers off
// (social_stickers.enabled), which hides them from the picker and from every place they were used.
const W = (body, bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><rect x="4" y="4" width="88" height="88" rx="22" fill="${bg}"/>${body}</svg>`;

const STICKERS = [
  { id: 'rocket', label: 'To the moon', svg: W('<path d="M48 14c12 8 18 22 16 40l-8 10H40l-8-10c-2-18 4-32 16-40z" fill="#f4f4f8"/><circle cx="48" cy="38" r="7" fill="#3a7bff"/><path d="M32 54l-8 14 12-4zM64 54l8 14-12-4z" fill="#ff4d5e"/><path d="M42 66h12l-6 16z" fill="#f59f00"/>', '#1d1b3a') },
  { id: 'bull', label: 'Bullish', svg: W('<path d="M22 30c4 8 10 10 16 10M74 30c-4 8-10 10-16 10" stroke="#f4f4f8" stroke-width="5" fill="none" stroke-linecap="round"/><ellipse cx="48" cy="54" rx="20" ry="18" fill="#2fd18b"/><ellipse cx="48" cy="64" rx="11" ry="7" fill="#0a875c"/><circle cx="41" cy="50" r="3" fill="#0b1d14"/><circle cx="55" cy="50" r="3" fill="#0b1d14"/><path d="M60 22l10 0-4 10z" fill="#2fd18b"/>', '#0f2a1f') },
  { id: 'bear', label: 'Bearish', svg: W('<circle cx="30" cy="30" r="9" fill="#c9773f"/><circle cx="66" cy="30" r="9" fill="#c9773f"/><circle cx="48" cy="52" r="24" fill="#c9773f"/><ellipse cx="48" cy="60" rx="11" ry="8" fill="#f1c9a5"/><circle cx="40" cy="46" r="3" fill="#2a1608"/><circle cx="56" cy="46" r="3" fill="#2a1608"/><path d="M62 70l12 10-14-2z" fill="#ff4d5e"/>', '#2d1a14') },
  { id: 'chart-up', label: 'Going up', svg: W('<path d="M18 74h60" stroke="#8b8fa8" stroke-width="3"/><path d="M20 66l16-14 12 8 26-28" stroke="#2fd18b" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 28h14v14z" fill="#2fd18b"/>', '#14182b') },
  { id: 'chart-down', label: 'Going down', svg: W('<path d="M18 74h60" stroke="#8b8fa8" stroke-width="3"/><path d="M20 30l16 14 12-8 26 26" stroke="#ff4d5e" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 68h14V54z" fill="#ff4d5e"/>', '#14182b') },
  { id: 'crystal-ball', label: 'Called it', svg: W('<circle cx="48" cy="44" r="22" fill="#8f7fff"/><circle cx="40" cy="36" r="6" fill="#d9d2ff"/><path d="M30 66h36l6 12H24z" fill="#f59f00"/>', '#211a3f') },
  { id: 'popcorn', label: 'Watching this', svg: W('<path d="M28 40h40l-6 40H34z" fill="#ff4d5e"/><path d="M38 40l2 40M48 40v40M58 40l-2 40" stroke="#f4f4f8" stroke-width="4"/><circle cx="34" cy="36" r="8" fill="#fff4cc"/><circle cx="46" cy="30" r="9" fill="#fff4cc"/><circle cx="59" cy="34" r="8" fill="#fff4cc"/>', '#2b1d12') },
  { id: 'gavel', label: 'Resolved', svg: W('<rect x="30" y="24" width="30" height="16" rx="4" transform="rotate(-35 45 32)" fill="#c9a26b"/><path d="M48 40l20 24" stroke="#8a6a3d" stroke-width="7" stroke-linecap="round"/><rect x="20" y="70" width="34" height="8" rx="3" fill="#8a6a3d"/>', '#1f1a14') },
  { id: 'ballot', label: 'I voted', svg: W('<rect x="22" y="42" width="52" height="36" rx="5" fill="#3a7bff"/><rect x="36" y="20" width="24" height="30" rx="3" fill="#f4f4f8"/><path d="M41 35l5 5 9-11" stroke="#2fd18b" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="32" y="44" width="32" height="5" rx="2" fill="#0d1b3a"/>', '#101a33') },
  { id: 'hourglass', label: 'Closing soon', svg: W('<path d="M30 18h36M30 78h36" stroke="#f4f4f8" stroke-width="6" stroke-linecap="round"/><path d="M34 22c0 14 14 18 14 26s-14 12-14 26h28c0-14-14-18-14-26s14-12 14-26z" fill="#15aabf"/><path d="M40 70h16l-8-10z" fill="#f59f00"/>', '#0f2328') },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));
const STICKER_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

module.exports = { STICKERS, BY_ID, STICKER_ID };

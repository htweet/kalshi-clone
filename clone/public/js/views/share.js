// Share sheet (PLAN P8.2, CLONE_SPEC.md §38.3): markets, events, your positions and your trades. Signed in, the server
// makes a signed, revocable link (/s/<token>) that counts opens and sign-ups; signed out, a market or event shares its
// plain page address. WhatsApp first (the main sharing channel in Nigeria), then X, Facebook, Telegram and copy-link.
// Positions and trades show the side always, the price unless unticked and the size only when ticked. The share URLs
// are plain links to each network's own share page; nothing is sent from the server.
import { t, te } from '../i18n.js';
import '../content/share-strings.js';
import { request } from '../api.js';
import { session } from '../store.js';
import { flagOn } from '../flags.js';
import { esc, toast } from '../lib.js';

// The channel order is the product decision (WhatsApp first). Each builds the network's public share URL.
const CHANNELS = [
  ['whatsapp', (url, text) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`],
  ['x', (url, text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`],
  ['facebook', (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`],
  ['telegram', (url, text) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`],
];
export const channelUrls = (url, text) => Object.fromEntries(CHANNELS.map(([k, f]) => [k, f(url, text)]));

function openDialog(html) {
  const d = document.createElement('dialog');
  d.className = 'share-dialog';
  d.dataset.testid = 'share-dialog';
  d.setAttribute('aria-labelledby', 'share-title');
  // eslint-disable-next-line parlance/no-unescaped-html -- the markup is built below from te() / esc() templates
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.showModal();
  return d;
}
function channelsHtml(url, text) {
  const u = channelUrls(url, text);
  return `<div class="share-channels" data-testid="share-channels">${CHANNELS.map(([k], i) => `<a class="btn ${i === 0 ? 'btn-primary' : ''} share-ch" data-channel="${esc(k)}" data-testid="share-${esc(k)}" href="${esc(u[k])}" target="_blank" rel="noopener noreferrer">${te(`share.channel.${k}`)}</a>`).join('')}
    <button type="button" class="btn share-ch" data-testid="share-copy">${te('share.channel.copy')}</button></div>
    <label class="share-url"><span class="sr-only">${te('share.link_label')}</span><input readonly value="${esc(url)}" data-testid="share-url"></label>`;
}
function wireChannels(d, url) {
  d.querySelector('[data-testid=share-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast(t('share.copied')); } catch { d.querySelector('[data-testid=share-url]').select(); toast(t('share.copy_manually')); }
  };
}

// opts: { kind: market|event|position|trade|invite, ticker, fillId, title, text, url (invite: the referral link) }
export async function shareDialog({ kind, ticker = null, fillId = null, title = '', text = '', url = null }) {
  const plain = url || `${location.origin}${location.pathname}${kind === 'market' && ticker ? `?market=${encodeURIComponent(ticker)}` : ''}`;
  const personal = kind === 'position' || kind === 'trade';
  if (kind === 'invite' || !flagOn('share_links') || !session.user) {
    if (personal) { toast(t('share.sign_in'), 'error'); return null; }
    const d = openDialog(`<h2 id="share-title">${te('share.title')}</h2><p class="faint">${esc(title)}</p>${channelsHtml(plain, text || title)}<div class="share-actions"><button class="btn" value="close" formmethod="dialog" data-close>${te('share.close')}</button></div>`);
    wireChannels(d, plain); d.querySelector('[data-close]').onclick = () => d.close();
    return d;
  }
  const opts = personal ? `<fieldset class="share-opts" data-testid="share-opts"><legend>${te('share.show_legend')}</legend>
      <label><input type="checkbox" checked disabled> ${te('share.show_side')}</label>
      <label><input type="checkbox" name="show_price" checked data-testid="share-show-price"> ${te('share.show_price')}</label>
      <label><input type="checkbox" name="show_size" data-testid="share-show-size"> ${te('share.show_size')}</label>
      <p class="faint">${te(flagOn('copy_trade') ? 'share.copy_note' : 'share.no_copy_note')}</p></fieldset>
      <button class="btn btn-primary" data-create data-testid="share-create">${te('share.create')}</button>` : '';
  const d = openDialog(`<h2 id="share-title">${te(personal ? `share.title_${kind}` : 'share.title')}</h2><p class="faint">${esc(title)}</p>${opts}<div data-out></div><div class="share-actions"><button class="btn" data-close>${te('share.close')}</button></div>`);
  d.querySelector('[data-close]').onclick = () => d.close();
  const out = d.querySelector('[data-out]');
  const create = async () => {
    const body = { kind, ...(kind === 'trade' ? { fill_id: fillId } : { ticker }) };
    if (personal) { body.show_price = d.querySelector('[name=show_price]').checked; body.show_size = d.querySelector('[name=show_size]').checked; }
    const r = await request('POST', `/v1/users/${encodeURIComponent(session.uid)}/share_links`, body);
    const url = `${location.origin}${r.share_link.url_path}`;
    const p = r.share_link.public;
    const shareText = kind === 'trade' ? t('share.text_trade', { side: String(p.side || '').toUpperCase(), title: p.title }) : kind === 'position' ? t('share.text_position', { side: String(p.side || '').toUpperCase(), title: p.title }) : text || title;
    out.innerHTML = channelsHtml(url, shareText);
    out.dataset.testid = 'share-ready';
    wireChannels(d, url);
    const c = d.querySelector('[data-create]'); if (c) c.remove();
    const o = d.querySelector('[data-testid=share-opts]'); if (o) o.disabled = true;
  };
  if (personal) d.querySelector('[data-create]').onclick = () => { create().catch((e) => toast(e.message, 'error')); };
  else await create().catch((e) => { out.innerHTML = channelsHtml(plain, text || title); wireChannels(d, plain); toast(e.message, 'error'); });
  return d;
}

// "Your share links" (Rewards): opens and sign-ups per link, revoke.
export async function shareLinksHtml() {
  if (!session.user || !flagOn('share_links')) return '';
  const r = await request('GET', `/v1/users/${encodeURIComponent(session.uid)}/share_links`);
  const rows = r.share_links.map((l) => `<tr data-testid="share-link-row" data-id="${esc(l.id)}" data-status="${esc(l.status)}"><td>${esc(l.title)}<div class="faint">${te(`share.kind.${l.kind}`)}</div></td><td class="num" data-testid="share-clicks">${esc(l.clicks)}</td><td class="num" data-testid="share-signups">${esc(l.signups)}</td>
    <td>${l.status === 'active' ? `<button class="btn btn-sm" data-revoke="${esc(l.id)}" data-testid="share-revoke">${te('share.revoke')}</button>` : `<span class="faint">${te('share.revoked')}</span>`}</td></tr>`).join('');
  return `<section class="card panel" data-testid="share-links"><h2>${te('share.links_title')}</h2><p class="muted">${te('share.links_intro')}</p>
    <div class="table-wrap"><table class="table"><thead><tr><th>${te('share.col.link')}</th><th class="num">${te('share.col.opens')}</th><th class="num">${te('share.col.signups')}</th><th><span class="sr-only">${te('share.col.actions')}</span></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="faint">${te('share.none')}</td></tr>`}</tbody></table></div></section>`;
}
export function wireShareLinks(root, redraw) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    try { await request('DELETE', `/v1/users/${encodeURIComponent(session.uid)}/share_links/${encodeURIComponent(b.dataset.revoke)}`); toast(t('share.revoked_toast')); redraw(); } catch (ex) { toast(ex.message, 'error'); }
  });
}

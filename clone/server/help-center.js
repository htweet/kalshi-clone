'use strict';
// Help Center API (owner request 2026-11-15, CLONE_SPEC.md §40). The guides are CMS pages `help/<slug>` (code defaults in
// server/content/help.js, edited in Admin › Content › Pages) plus the older help collection (`cms_help`, §18.5, shown
// under "More help"). Public:
//   GET  /v1/help                     the guides by topic: slug, title, category, summary, position (hidden guides left out)
//   GET  /v1/help/search?q=           ranked matches in titles, summaries and bodies, with a snippet
//   GET  /v1/help/:slug               one guide: body (sanitised), topic, related guides, the visitor's own vote
//   POST /v1/help/:slug/feedback      "Was this helpful?": {helpful, comment?, voter?}; one vote per voter and guide
// Admin (content.write):
//   GET  /v1/admin/help/feedback      per guide: yes / no counts and the latest comments
const crypto = require('node:crypto');
const { E, newId, nowIso } = require('./util');
const { FieldError } = require('./admin');
const { CATEGORIES } = require('./content/help');
const { plainProblem } = require('./cms/sanitize');

const MORE = 'more'; // topic of the §18.5 help collection rows
const plain = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function mountHelpCenter({ v1, app, db, admin }) {
  const cms = () => app.locals.cms;
  const preview = (req) => req.query.preview === '1' && req.auth && admin.rolesOf(req.auth.user).some((r) => ['admin', 'editor', 'publisher'].includes(r));

  // Every guide (CMS pages under help/ and the §18.5 collection), with its plain text for search.
  function guides(withDrafts = false) {
    const c = cms();
    const out = [];
    const seen = new Set();
    for (const row of db.prepare('SELECT slug,title,body,position,updated_at FROM cms_help WHERE published=1 AND active=1 ORDER BY position, title').all()) {
      seen.add(row.slug);
      out.push({ slug: row.slug, title: row.title, category: MORE, summary: '', position: 1000 + row.position, related: [], updated_time: row.updated_at, legacy: true, text: plain(row.body) });
    }
    for (const p of c.pageList(withDrafts)) {
      if (!p.slug.startsWith('help/')) continue;
      const slug = p.slug.slice(5);
      if (seen.has(slug) || p.hidden) continue;
      const full = c.pageOf(p.slug, withDrafts);
      if (!full || !full.body) continue;
      out.push({ slug, title: full.title, category: CATEGORIES.includes(full.category) ? full.category : 'getting-started', summary: full.summary || '', position: full.position, related: full.related || [], text: plain(full.body) });
    }
    return out.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  }
  const listVo = (g) => ({ slug: g.slug, title: g.title, category: g.category, summary: g.summary, position: g.position });

  v1.get('/help', (req, res) => {
    res.json({ categories: [...CATEGORIES, MORE], pages: guides(preview(req)).map(listVo) });
  });

  v1.get('/help/search', (req, res) => {
    const q = norm(String(req.query.q || '').slice(0, 100)).trim();
    const terms = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 8);
    if (!terms.length) return res.json({ query: q, results: [] });
    const results = [];
    for (const g of guides(preview(req))) {
      const title = norm(g.title); const summary = norm(g.summary); const body = norm(g.text);
      let score = 0; let all = true;
      for (const t of terms) {
        const s = (title.includes(t) ? 6 : 0) + (summary.includes(t) ? 3 : 0) + (body.includes(t) ? 1 + Math.min(4, body.split(t).length - 2) * 0.25 : 0);
        if (!s) all = false;
        score += s;
      }
      if (!score) continue;
      if (all) score += 5; // every word found
      if (title.includes(q)) score += 8; // the whole phrase in the title
      const at = body.indexOf(terms[0]);
      const snippet = g.summary || (at >= 0 ? `${at > 40 ? '…' : ''}${g.text.slice(Math.max(0, at - 40), at + 140).trim()}…` : g.text.slice(0, 160));
      results.push({ ...listVo(g), snippet, score });
    }
    results.sort((a, b) => b.score - a.score || a.position - b.position);
    res.json({ query: q, results: results.slice(0, 20).map(({ score, ...r }) => { void score; return r; }) });
  });

  const voterOf = (req, token) => {
    if (req.auth) return `u:${req.auth.user.id}`;
    const t = String(token || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(t)) return null;
    return `a:${crypto.createHash('sha256').update(t).digest('hex').slice(0, 32)}`;
  };

  v1.get('/help/:slug', (req, res) => {
    const slug = String(req.params.slug).toLowerCase();
    const row = db.prepare('SELECT * FROM cms_help WHERE slug=? AND published=1 AND active=1').get(slug);
    const all = guides(preview(req));
    const titles = new Map(all.map((g) => [g.slug, g]));
    const voter = voterOf(req, req.query.voter);
    const vote = voter ? db.prepare('SELECT helpful FROM help_feedback WHERE slug=? AND voter=?').get(slug, voter) : null;
    const yourVote = vote ? (vote.helpful ? 'yes' : 'no') : null;
    if (row) return res.json({ page: { slug: row.slug, title: row.title, body: row.body, category: MORE, related: [], updated_time: row.updated_at, your_vote: yourVote } });
    const c = cms();
    const p = /^[a-z0-9][a-z0-9-]{0,59}$/.test(slug) ? c.pageOf(`help/${slug}`, preview(req)) : null;
    if (!p || !p.body || (p.hidden && !preview(req))) throw E.notFound();
    const { sanitize } = require('./cms/sanitize');
    const related = (p.related || []).map((r) => titles.get(r)).filter(Boolean).map(listVo);
    // Fill up to three related guides from the same topic when fewer were chosen.
    for (const g of all) { if (related.length >= 3) break; if (g.category === p.category && g.slug !== slug && !related.some((r) => r.slug === g.slug)) related.push(listVo(g)); }
    if (preview(req)) res.setHeader('Cache-Control', 'no-store');
    res.json({ page: { slug, title: p.title, html: sanitize(p.body, 'page'), format: 'html', category: p.category, summary: p.summary, related: related.slice(0, 6), your_vote: yourVote, customised: p.customised } });
  });

  v1.post('/help/:slug/feedback', (req, res) => {
    const slug = String(req.params.slug).toLowerCase();
    if (!guides(false).some((g) => g.slug === slug)) throw E.notFound();
    const b = req.body || {};
    if (typeof b.helpful !== 'boolean') throw new FieldError({ helpful: 'must be true or false' });
    const comment = String(b.comment ?? '').trim();
    if (comment.length > 500) throw new FieldError({ comment: 'at most 500 characters' });
    const pp = comment && plainProblem(comment); if (pp) throw new FieldError({ comment: pp });
    const voter = voterOf(req, b.voter);
    if (!voter) throw new FieldError({ voter: 'a voter token (16-64 letters, digits, - or _) is needed when signed out' });
    const now = nowIso();
    const prev = db.prepare('SELECT id, comment FROM help_feedback WHERE slug=? AND voter=?').get(slug, voter);
    if (prev) db.prepare('UPDATE help_feedback SET helpful=?, comment=?, updated_at=? WHERE id=?').run(b.helpful ? 1 : 0, comment || (b.comment === undefined ? prev.comment : ''), now, prev.id);
    else db.prepare('INSERT INTO help_feedback(id,slug,voter,user_id,helpful,comment,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(newId('hf_'), slug, voter, req.auth ? req.auth.user.id : null, b.helpful ? 1 : 0, comment, now, now);
    res.status(prev ? 200 : 201).json({ feedback: { slug, helpful: b.helpful, comment } });
  });

  v1.get('/admin/help/feedback', admin.can('content.write'), (req, res) => {
    const titles = new Map(guides(true).map((g) => [g.slug, g.title]));
    const counts = db.prepare('SELECT slug, SUM(helpful) yes, SUM(1-helpful) no, MAX(updated_at) last FROM help_feedback GROUP BY slug').all();
    const by = new Map(counts.map((c) => [c.slug, c]));
    const rows = [...new Set([...titles.keys(), ...by.keys()])].map((slug) => {
      const c = by.get(slug) || { yes: 0, no: 0, last: null };
      const total = c.yes + c.no;
      return { slug, title: titles.get(slug) || slug, yes: c.yes, no: c.no, total, helpful_pct: total ? Math.round((c.yes / total) * 100) : null, last_time: c.last };
    }).sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
    const comments = db.prepare("SELECT slug, helpful, comment, updated_at FROM help_feedback WHERE comment<>'' ORDER BY updated_at DESC LIMIT 100").all()
      .map((c) => ({ slug: c.slug, title: titles.get(c.slug) || c.slug, helpful: !!c.helpful, comment: c.comment, time: c.updated_at }));
    res.json({ guides: rows, comments });
  });

  return { guides };
}

module.exports = { mountHelpCenter };

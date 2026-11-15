'use strict';
// Migration 0007 — content operations part 1 (owner decisions 2026-11-15, CLONE_SPEC.md §41). Self-contained: every
// table, column and seed row of the news ingestion queue and the auto-written market content queue is here.
//   news_sources          the admin-managed publisher list (RSS feed, default category, on/off, fetch interval) and the
//                         last fetch status per source; seeded with the eight Nigerian publishers of the owner decision
//   news_fetch_log        one row per fetch (status, HTTP code, bytes, items, new, duplicates, time, error)
//   news_items            the review queue: headline, link, a short plain-text excerpt (<= 300 characters) and the
//                         publisher only — never the article; de-duplicated by normalised URL and title hash
//   news_category_rules   owner-editable keyword rules that put an item in one of the site categories
//   market_content_queue  generated description / background / resolution notes per event, reviewed before publishing
//                         (the published text is the CMS entry `market_content/<event>`, versioned with history)
//   content_ai_usage      external-provider requests and tokens per UTC day (daily cap)
// cms_news gains the original article link and the queue item it came from (approved items attach to events there).
const SQL = `
CREATE TABLE IF NOT EXISTS news_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, feed_url TEXT NOT NULL, default_category TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 30, position INTEGER NOT NULL DEFAULT 0, etag TEXT, last_modified TEXT, last_fetch_ts INTEGER, last_status TEXT, last_http INTEGER,
  last_error TEXT, last_items INTEGER NOT NULL DEFAULT 0, last_new INTEGER NOT NULL DEFAULT 0, last_duplicates INTEGER NOT NULL DEFAULT 0, last_bytes INTEGER NOT NULL DEFAULT 0,
  last_ms INTEGER NOT NULL DEFAULT 0, last_ok_ts INTEGER, fetch_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_sources_url ON news_sources(feed_url);
CREATE TABLE IF NOT EXISTS news_fetch_log (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, ts INTEGER NOT NULL, trigger TEXT NOT NULL DEFAULT 'schedule', status TEXT NOT NULL, http INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0, items INTEGER NOT NULL DEFAULT 0, new_items INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS idx_news_fetch_log_source ON news_fetch_log(source_id, ts);
CREATE TABLE IF NOT EXISTS news_items (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT NOT NULL, url_norm TEXT NOT NULL, title_hash TEXT NOT NULL, guid TEXT,
  headline_orig TEXT NOT NULL, excerpt_orig TEXT NOT NULL DEFAULT '', headline TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', published_ts INTEGER NOT NULL, fetched_ts INTEGER NOT NULL,
  category TEXT NOT NULL, category_method TEXT NOT NULL DEFAULT 'rules', category_score INTEGER NOT NULL DEFAULT 0, suggested_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending', events_json TEXT NOT NULL DEFAULT '[]', edited INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT, decided_email TEXT, decided_ts INTEGER, decision_reason TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_items_url ON news_items(url_norm);
CREATE INDEX IF NOT EXISTS idx_news_items_title ON news_items(title_hash);
CREATE INDEX IF NOT EXISTS idx_news_items_status ON news_items(status, fetched_ts);
CREATE INDEX IF NOT EXISTS idx_news_items_public ON news_items(status, category, published_ts);
CREATE TABLE IF NOT EXISTS news_category_rules (id TEXT PRIMARY KEY, category TEXT NOT NULL, keyword TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_rules_kw ON news_category_rules(category, keyword);
CREATE TABLE IF NOT EXISTS market_content_queue (id TEXT PRIMARY KEY, event_ticker TEXT NOT NULL, input_hash TEXT NOT NULL, generator TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  description TEXT NOT NULL, background TEXT NOT NULL, resolution_notes TEXT NOT NULL, fallback_reason TEXT NOT NULL DEFAULT '', trigger TEXT NOT NULL DEFAULT 'schedule',
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL,
  decided_by TEXT, decided_email TEXT, decided_ts INTEGER, decision_reason TEXT NOT NULL DEFAULT '', published_version INTEGER);
CREATE INDEX IF NOT EXISTS idx_mcq_event ON market_content_queue(event_ticker, created_ts);
CREATE INDEX IF NOT EXISTS idx_mcq_status ON market_content_queue(status, created_ts);
CREATE TABLE IF NOT EXISTS content_ai_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0);
`;

// The owner's list (2026-11-15): public RSS feeds of the top Nigerian publishers. Default category: where an item goes
// when no keyword rule matches.
const SOURCES = [
  ['Punch', 'https://punchng.com/feed/', 'Politics'],
  ['Vanguard', 'https://www.vanguardngr.com/feed/', 'Politics'],
  ['Premium Times', 'https://www.premiumtimesng.com/feed', 'Politics'],
  ['Channels TV', 'https://www.channelstv.com/feed/', 'Politics'],
  ['The Guardian Nigeria', 'https://guardian.ng/feed/', 'Politics'],
  ['ThisDay', 'https://www.thisdaylive.com/index.php/feed/', 'Politics'],
  ['BusinessDay', 'https://businessday.ng/feed/', 'Economics'],
  ['Nairametrics', 'https://nairametrics.com/feed/', 'Financials'],
];
// Keyword rules per site category (server/features.js CATEGORIES). Whole words, case-insensitive; a match in the
// headline counts twice. No personal names: rules are about topics, never people.
const RULES = {
  Politics: ['senate', 'council', 'national assembly', 'house of representatives', 'lawmakers', 'governor', 'governors', 'minister', 'presidency', 'cabinet', 'parliament', 'bill', 'state assembly', 'federal government', 'party'],
  Elections: ['election', 'elections', 'inec', 'poll', 'polls', 'ballot', 'primaries', 'primary election', 'voters', 'voter', 'campaign', 'candidate', 'candidates', 'by-election', 'governorship election'],
  Economics: ['inflation', 'gdp', 'cbn', 'central bank', 'interest rate', 'monetary policy', 'budget', 'naira', 'exchange rate', 'unemployment', 'fuel price', 'petrol', 'nbs', 'tax', 'economy', 'recession'],
  Financials: ['stock', 'stocks', 'shares', 'ngx', 'stock exchange', 'bond', 'bonds', 'treasury bills', 'banks', 'banking', 'dividend', 'investors', 'equities', 'market capitalisation'],
  Companies: ['company', 'companies', 'firm', 'ceo', 'profit', 'revenue', 'acquisition', 'merger', 'telecom', 'earnings', 'startup', 'listed company', 'shareholders'],
  Crypto: ['bitcoin', 'crypto', 'cryptocurrency', 'blockchain', 'ethereum', 'stablecoin', 'digital assets', 'web3'],
  Sports: ['super eagles', 'super falcons', 'football', 'npfl', 'afcon', 'match', 'league', 'coach', 'striker', 'basketball', 'athletics', 'olympics', 'world cup', 'tournament'],
  Entertainment: ['nollywood', 'afrobeats', 'music', 'album', 'film', 'movie', 'bbnaija', 'concert', 'grammy', 'celebrity', 'box office', 'singer', 'actor', 'actress'],
  'Climate and Weather': ['flood', 'flooding', 'rainfall', 'weather', 'nimet', 'climate', 'drought', 'heatwave', 'temperature', 'harmattan', 'storm', 'erosion'],
  'Science and Technology': ['technology', 'tech', 'artificial intelligence', 'satellite', 'internet', 'broadband', 'research', 'science', 'nitda', 'software', 'cybersecurity', 'data centre'],
};
const COLUMNS = [['cms_news', 'url', "TEXT NOT NULL DEFAULT ''"], ['cms_news', 'ingest_item_id', 'TEXT']];
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

module.exports = {
  id: 7,
  name: 'content-queue',
  up(db) {
    db.exec(SQL);
    for (const [t, c, def] of COLUMNS) {
      if (!hasTable(db, t)) continue;
      if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
    }
    if (hasTable(db, 'cms_news')) db.exec('CREATE INDEX IF NOT EXISTS idx_cms_news_ingest ON cms_news(ingest_item_id)');
    const now = Date.now();
    const src = db.prepare('INSERT INTO news_sources(id,name,feed_url,default_category,enabled,interval_minutes,position,created_by,created_ts,updated_ts) VALUES(?,?,?,?,1,30,?,?,?,?) ON CONFLICT DO NOTHING');
    SOURCES.forEach(([name, url, cat], i) => src.run(`nsrc_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name, url, cat, i, 'migration 0007', now, now));
    const rule = db.prepare('INSERT INTO news_category_rules(id,category,keyword,weight,active,created_by,created_ts,updated_ts) VALUES(?,?,?,1,1,?,?,?) ON CONFLICT DO NOTHING');
    let n = 0;
    for (const [cat, words] of Object.entries(RULES)) for (const w of words) rule.run(`nrule_${String(++n).padStart(4, '0')}`, cat, w, 'migration 0007', now, now);
  },
  SOURCES,
  RULES,
};

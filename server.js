const express   = require('express');
const path      = require('path');
const axios     = require('axios');
const cheerio   = require('cheerio');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const scraper   = require('./scraper');
const { assertSafeOutboundUrl } = require('./lib/security');
const sync      = require('./lib/sync');

const app = express();

// Trust Nginx reverse proxy so rate-limit / req.ip see the real client IP.
app.set('trust proxy', 1);

// Security headers. CSP is intentionally permissive on media/frame sources
// because the app IS an embed host proxy — tightened mainly for scripts/styles.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src':  ["'self'"],
      'script-src':   ["'self'", "'unsafe-inline'"],
      'style-src':    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src':     ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src':      ["'self'", 'data:', 'https:'],
      'media-src':    ["'self'", 'https:', 'blob:'],
      'connect-src':  ["'self'", 'https:'],
      'frame-src':    ["'self'", 'https:'],
      'object-src':   ["'none'"],
      'base-uri':     ["'self'"],
      'frame-ancestors': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // embeds rely on default (permissive)
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(express.json());

// Maintenance mode — flip via MAINTENANCE_MODE=1 in the environment. When on,
// every request short-circuits to public/maintenance.html (HTML 503 for normal
// requests, JSON 503 for /api/*). Useful when upstream rotates and we need to
// take playback offline while re-engineering the scraper.
if (process.env.MAINTENANCE_MODE === '1') {
  const maintenancePath = path.join(__dirname, 'public', 'maintenance.html');
  app.use((req, res) => {
    res.status(503);
    res.set('Cache-Control', 'no-store');
    res.set('Retry-After', '3600');
    if (req.path.startsWith('/api/')) {
      return res.json({ error: 'Service under maintenance — playback temporarily offline' });
    }
    res.sendFile(maintenancePath);
  });
  console.log('[server] MAINTENANCE_MODE=1 — all routes serving maintenance page');
}

// Token-bucket rate limit on API routes. Static assets + SPA fallback are free.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,                     // 120 req/min per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
});
app.use('/api/', apiLimiter);

const DETAIL_VIEW_MODE = process.env.DETAIL_VIEW_MODE === 'page' ? 'page' : 'modal';
app.get('/app-config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.send(`window.SINEPIL_CONFIG=${JSON.stringify({ detailViewMode: DETAIL_VIEW_MODE })};`);
});
// Force browsers to revalidate static assets (CSS/JS/HTML) on every request.
// Without this, Chrome's heuristic cache silently serves stale files for hours
// after a deploy — UI changes appear "broken" until the user hard-refreshes.
// ETag/Last-Modified still apply, so unchanged files return 304 (cheap).
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      // Images, fonts, favicons — safe to cache for a day.
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

const SOURCE_ORIGIN = 'https://tv10.lk21official.cc';
const BROWSER_UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PLAYER_HDRS = {
  'User-Agent': BROWSER_UA,
  'Referer':    SOURCE_ORIGIN + '/',
  'Origin':     SOURCE_ORIGIN,
  'Accept':     'text/html,application/xhtml+xml,*/*',
};

// Injected into every proxied player page:
//  1. Spoof document.referrer
//  2. Block all popup / popunder / redirect ad techniques
const SPOOF_SCRIPT = `<script>
(function(){
  /* --- Spoof referrer --- */
  try {
    Object.defineProperty(document, 'referrer', {
      get: function(){ return '${SOURCE_ORIGIN}/'; },
      configurable: true
    });
  } catch(e){}

  /* --- Ad blocker: kill every popup / redirect technique --- */

  // 1. window.open → no-op (covers popunders, new-tab ads)
  window.open = function(){ return null; };

  // 2. Prevent top-frame navigation (window.top.location = ...)
  try {
    Object.defineProperty(window, 'top', { get: function(){ return window; } });
  } catch(e){}

  // 3. Block fetch/XHR to known ad domains
  var AD_HOSTS = /popads|popcash|popunder|exoclick|juicyads|trafficjunky|hilltopads|adcash|propellerads|adsterra|monetag|yllix|olavivo|clickaine/i;
  var _fetch = window.fetch;
  window.fetch = function(input){
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if(AD_HOSTS.test(url)) return Promise.resolve(new Response('', {status:204}));
    return _fetch.apply(this, arguments);
  };

  // 4. Strip body/document onclick ad triggers after DOM is ready
  document.addEventListener('DOMContentLoaded', function(){
    document.body && (document.body.onclick = null);
    document.documentElement.onclick = null;
  }, { once: true });

  // 5. Block programmatic anchor clicks that bypass window.open
  document.addEventListener('click', function(e){
    var el = e.target && e.target.closest('a');
    if(el && el.target === '_blank' && !el.href.includes(location.hostname)){
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
})();
</script>`;

/* ======================================================
   Scraper routes
   ====================================================== */

// Whitelist characters accepted in user-supplied browse paths before
// interpolating into source URLs. Allows letters/digits/dashes/slashes only.
const BROWSE_PATH_RE = /^[a-z0-9/-]{0,100}$/i;
function isSafeBrowsePath(p) {
  return typeof p === 'string' && BROWSE_PATH_RE.test(p);
}

function sendErr(res, e) {
  const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
  // Don't leak stack traces; only message
  res.status(status).json({ error: e?.message || 'Internal error' });
}

app.get(/^\/api\/movie\/(.+)$/, async (req, res) => {
  try {
    if (!scraper.isSafeSlug(req.params[0])) return res.status(400).json({ error: 'Invalid slug' });
    res.json(await scraper.getMovie(req.params[0]));
  } catch (e) {
    console.error('movie error:', e.message);
    sendErr(res, e);
  }
});

app.get(/^\/api\/series\/([^/]+)$/, async (req, res) => {
  try {
    if (!scraper.isSafeSlug(req.params[0])) return res.status(400).json({ error: 'Invalid slug' });
    res.json(await scraper.getSeries(req.params[0]));
  } catch (e) {
    console.error('series error:', e.message);
    sendErr(res, e);
  }
});

app.get(/^\/api\/episode\/([^/]+)\/(\d{1,2})\/(\d{1,3})$/, async (req, res) => {
  try {
    const [, slug, s, e] = req.params ? [null, req.params[0], req.params[1], req.params[2]] : [];
    if (!scraper.isSafeSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
    res.json(await scraper.getEpisode(slug, s, e));
  } catch (err) {
    console.error('episode error:', err.message);
    sendErr(res, err);
  }
});

// Resolve a source web URL to a {kind, slug, [season, episode]} so the frontend
// can route to the right modal.
// Supports source movie URLs and source series/episode URLs.
app.get('/api/slug-from-url', (req, res) => {
  const hit = scraper.fromSourceUrl(req.query.url || '');
  if (!hit) return res.status(400).json({ error: 'URL not recognised — must be a lk21 movie or nontondrama series link' });
  res.json(hit);
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);
    const kind = ['movie', 'series', 'all'].includes(req.query.kind) ? req.query.kind : 'all';
    res.json(await scraper.search(q, kind));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/browse', async (req, res) => {
  try {
    const p = req.query.path || '';
    if (!isSafeBrowsePath(p)) return res.status(400).json({ error: 'Invalid path' });
    res.json(await scraper.browse(p));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/browse/series', async (req, res) => {
  try {
    const p = req.query.path || '';
    if (!isSafeBrowsePath(p)) return res.status(400).json({ error: 'Invalid path' });
    res.json(await scraper.browseSeries(p));
  } catch (e) { sendErr(res, e); }
});

/* ======================================================
   Cross-device sync
   - POST /api/sync/create      → { code, token, code_expires_at }
   - POST /api/sync/pair        → { token, payload, updated_at }
   - GET  /api/sync/pull        → { payload, updated_at }       (auth: token)
   - POST /api/sync/push        → { payload, updated_at }       (auth: token,
                                    server-merged result returned)
   - POST /api/sync/regenerate  → { code, code_expires_at }     (auth: token)
   - POST /api/sync/disconnect  → 204                           (auth: token)
   ====================================================== */

app.post('/api/sync/create', (req, res) => {
  try { res.json(sync.createSlot()); }
  catch (e) { sendErr(res, e); }
});

app.post('/api/sync/pair', (req, res) => {
  try {
    const code = String(req.body?.code || '').toUpperCase();
    res.json(sync.pairWithCode(code));
  } catch (e) { sendErr(res, e); }
});

// Token in `Authorization: Bearer <token>` — NOT the query string. Query
// strings end up in access logs, browser history, and Referer headers; the
// sync token grants full read/write of the user's history+wishlist, so we
// treat it like a session credential.
app.get('/api/sync/pull', (req, res) => {
  try {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m ? m[1] : '';
    res.json(sync.pullByToken(token));
  } catch (e) { sendErr(res, e); }
});

app.post('/api/sync/push', (req, res) => {
  try {
    const token = String(req.body?.token || '');
    if (req.body?.payload === undefined) return res.status(400).json({ error: 'Missing payload' });
    res.json(sync.pushByToken(token, req.body.payload));
  } catch (e) { sendErr(res, e); }
});

app.post('/api/sync/regenerate', (req, res) => {
  try {
    const token = String(req.body?.token || '');
    res.json(sync.regenerateCode(token));
  } catch (e) { sendErr(res, e); }
});

app.post('/api/sync/disconnect', (req, res) => {
  sync.disconnect(String(req.body?.token || ''));
  res.status(204).end();
});

// Home view — returns an array of rails [{ id, title, path, items }].
app.get('/api/home', async (req, res) => {
  try {
    const kind = req.query.kind === 'series' ? 'series' : 'movie';
    res.json(await scraper.homeRails(kind));
  } catch (e) { sendErr(res, e); }
});


/* ======================================================
   Generic proxy
   - Fetches URL with source-site Referer from our server
   - Strips CSP frame-ancestors so iframe embedding works
   - For HTML: injects <base href> + spoof script
   ====================================================== */

// Follow redirects manually so we can re-run `assertSafeOutboundUrl` on every
// hop. Without this, an allowlisted host can 302 to a private IP (cloud metadata,
// localhost, another container on the Docker network) and axios will dutifully
// follow — bypassing the SSRF guard, which only checked the initial URL.
const MAX_REDIRECT_HOPS  = 5;
const PROXY_MAX_BODY     = 10 * 1024 * 1024; // 10 MB — caps memory per request

async function safeProxyFetch(initialUrl, axiosOpts) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertSafeOutboundUrl(currentUrl);
    const response = await axios.get(currentUrl, {
      ...axiosOpts,
      maxRedirects:    0,                          // we drive the redirect loop
      validateStatus:  (s) => s >= 200 && s < 400, // accept 2xx + 3xx, throw on 4xx/5xx
    });
    if (response.status < 300) return response;
    const loc = response.headers.location;
    if (!loc) return response; // 3xx without Location — return as-is
    currentUrl = new URL(loc, currentUrl).href;
  }
  const e = new Error('Too many redirects'); e.status = 502; throw e;
}

app.get('/api/proxy', async (req, res) => {
  const url = req.query.url || '';
  if (!url) return res.status(400).send('Missing url');

  let response;
  try {
    response = await safeProxyFetch(url, {
      headers: {
        ...PLAYER_HDRS,
        Referer: 'https://playeriframe.sbs/',
        Origin:  'https://playeriframe.sbs',
      },
      responseType:     'arraybuffer',
      timeout:          15000,
      maxContentLength: PROXY_MAX_BODY,
      maxBodyLength:    PROXY_MAX_BODY,
    });
  } catch (e) {
    return res.status(e.status || 502).send(e.message || 'Proxy error');
  }

  try {
    const ct = response.headers['content-type'] || 'text/html';
    res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    // Do NOT forward CSP or X-Frame-Options

    if (ct.includes('text/html')) {
      let html = Buffer.from(response.data).toString('utf-8');

      // Determine base origin from the final resolved URL
      let baseHref = url;
      try { baseHref = new URL(url).origin + '/'; } catch {}

      // Inject base href + spoof script into <head>
      const inject = `<base href="${baseHref}">${SPOOF_SCRIPT}`;
      html = html.includes('<head>')
        ? html.replace('<head>', `<head>${inject}`)
        : inject + html;

      // Strip meta CSP tags
      html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

      // Strip external ad scripts by known ad-network domains
      html = html.replace(
        /<script[^>]+src=["'][^"']*(?:popads|popcash|popunder|exoclick|juicyads|trafficjunky|hilltopads|adcash|propellerads|adsterra|monetag|yllix|olavivo|clickaine|revcontent)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
      );

      res.send(html);
    } else {
      const fwd = ['cache-control', 'content-encoding'];
      fwd.forEach(h => { if (response.headers[h]) res.set(h, response.headers[h]); });
      res.send(Buffer.from(response.data));
    }
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
});

/* ======================================================
   /movie/:slug + /series/:slug — bot-aware OG meta renderer
   Regular browsers get index.html (SPA handles it).
   Crawlers (WhatsApp, Telegram, Twitter, etc.) get a
   minimal HTML page with item-specific OG tags so the
   link preview shows the actual poster + title.
   ====================================================== */

const BOT_UA = /WhatsApp|Telegram|TelegramBot|Twitterbot|facebookexternalhit|LinkedInBot|Discordbot|Slackbot-Linkexpanding|Applebot|Googlebot|bingbot/i;

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendOgPage(res, { title, description, image, url, ogType, alt }) {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)}</title>
  <meta property="og:type" content="${escHtml(ogType)}">
  <meta property="og:site_name" content="SinepilStream">
  <meta property="og:url" content="${escHtml(url)}">
  <meta property="og:title" content="${escHtml(title)}">
  <meta property="og:description" content="${escHtml(description)}">
  <meta property="og:image" content="${escHtml(image)}">
  <meta property="og:image:alt" content="${escHtml(alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(title)}">
  <meta name="twitter:description" content="${escHtml(description)}">
  <meta name="twitter:image" content="${escHtml(image)}">
  <link rel="canonical" href="${escHtml(url)}">
</head>
<body></body>
</html>`);
}

app.get('/movie/:slug', async (req, res, next) => {
  if (!BOT_UA.test(req.headers['user-agent'] || '')) return next();
  try {
    const data = await scraper.getMovie(req.params.slug);
    if (!data || data.isSeries || data.error) return next();

    const title = data.title + (data.year ? ` (${data.year})` : '') + ' — SinepilStream';
    const desc  = (data.description || `Watch ${data.title} on SinepilStream — ad-free.`).slice(0, 200);
    const image = data.poster || `https://${req.headers.host}/og-image.png`;
    const url   = `https://${req.headers.host}/movie/${encodeURIComponent(req.params.slug)}`;
    sendOgPage(res, { title, description: desc, image, url, ogType: 'video.movie', alt: data.title });
  } catch { next(); }
});

app.get('/series/:slug', async (req, res, next) => {
  if (!BOT_UA.test(req.headers['user-agent'] || '')) return next();
  try {
    const data = await scraper.getSeries(req.params.slug);
    if (!data || data.error) return next();

    // Series titles get season-count suffix when multi-season ("(3 seasons)"),
    // otherwise fall back to start year — same shape as movies for single-season shows.
    const suffix = data.total_seasons > 1
      ? ` (${data.total_seasons} seasons)`
      : (data.year ? ` (${data.year})` : '');
    const title = data.title + suffix + ' — SinepilStream';
    const desc  = (data.description || `Watch ${data.title} on SinepilStream — ad-free.`).slice(0, 200);
    const image = data.poster || `https://${req.headers.host}/og-image.png`;
    const url   = `https://${req.headers.host}/series/${encodeURIComponent(req.params.slug)}`;
    sendOgPage(res, { title, description: desc, image, url, ogType: 'video.tv_show', alt: data.title });
  } catch { next(); }
});

/* ======================================================
   SPA fallback
   ====================================================== */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`SinepilStream running at http://localhost:${PORT}`);
  scraper.startSeeding();
  // Signal PM2 that the process is ready — required for zero-downtime reload.
  // pm2 reload waits for this before killing the old process.
  if (process.send) process.send('ready');
});

// Graceful shutdown — finish in-flight requests before exiting.
// Triggered by PM2 reload (SIGINT) or docker stop (SIGTERM).
let shuttingDown = false;
let forceExitTimer = null;

function shutdown(signal) {
  if (shuttingDown) {
    console.warn(`[${signal}] Shutdown already in progress; press Ctrl-C again after timeout or wait for exit.`);
    return;
  }

  shuttingDown = true;
  console.log(`[${signal}] Shutting down gracefully…`);

  server.close(() => {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    console.log('All connections closed. Exiting.');
    process.exit(0);
  });

  // Force-exit after 15 s if connections are stuck.
  forceExitTimer = setTimeout(() => {
    console.warn('Force exit after timeout');
    process.exit(1);
  }, 15000);
  forceExitTimer.unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

# How SinepilStream Scraping Works

SinepilStream scrapes two upstream sources:

| Kind    | Primary host                                         | Notes                                                       |
|---------|------------------------------------------------------|-------------------------------------------------------------|
| Movies  | `tvN.lk21official.cc` (rotates — see failover below) | WordPress-based movie catalogue                             |
| Series  | `tvN.nontondrama.my`                                 | Same operator as the movie site; shared slug/schema conventions |

Both expose schema.org-microdata listings, JSON-LD detail pages, and use the same embed hosts (`playeriframe.sbs` wrappers → `emturbovid.com` / `f16px.com` / `short.icu`). That let us build one shared player resolver and one shared card extractor — see [ARCHITECTURE.md](ARCHITECTURE.md) for how the modules are wired.

---

## Request flow (high level)

```
User browser
    │ GET /api/home?kind=movie|series
    ▼
SinepilStream server (Node.js / Express)
    │
    ├─ lib/cache.js   : SQLite response cache (SWR + in-flight coalescing)
    ├─ lib/sources/*  : upstream HTML / JSON-LD scraping
    ├─ lib/resolver.js: encrypted token / playeriframe.sbs wrapper → inner player URL
    └─ lib/decrypt.js : jsdom sandbox that runs upstream's player.js to decrypt tokens

Browser renders rails of cards. Clicking a card →
    GET /api/movie/:slug  or  /api/series/:slug
        ↓ (cached on server, parsed from JSON-LD)
    Returns metadata + pre-resolved player list
        ↓
    Browser embeds <iframe src="…emturbovid.com/…">  (direct when possible)
```

All scraping runs server-side. The browser never talks to the source sites directly — only to our server, which fetches and transforms on the fly.

---

## 1. Browse & listing

Cards on each source share the same schema.org markup:

```html
<article itemscope itemtype="https://schema.org/Movie">
  <a itemprop="url" href="/slug-year" title="Nonton movie/series …">…</a>
  <h3 class="poster-title" itemprop="name">Title</h3>
  <img itemprop="image" src="https://static-jpg.lk21.party/…">
  <span itemprop="ratingValue">8.2</span>
  <span class="year" itemprop="datePublished">2026</span>
  <span class="episode">EPS <strong>4</strong></span>   <!-- series only -->
  <span class="duration">S.1</span>                       <!-- series only -->
  <meta itemprop="genre" content="Comedy, Drama, Romance">
</article>
```

`extractCards($)` (each in `lib/sources/movies.js` and `lib/sources/series.js`) walks these and returns flat card objects. Series cards carry `total_seasons` and `total_episodes` derived from the `.duration` and `.episode` badges.

Both sources support:

```
GET /                      — latest
GET /year/YYYY/            — by release year
GET /genre/<slug>/         — by genre (limited set confirmed on series)
```

Each supported path becomes a rail on the home view (`lib/index.js` → `MOVIE_HOME_RAILS` / `SERIES_HOME_RAILS`).

---

## 2. Search

The movie site's autocomplete API at `gudangvape.com/search.php` is **shared** between the movie and series sites — it returns both kinds with a `type` field:

```json
GET https://gudangvape.com/search.php?s=young+sheldon
{ "data": [
  { "slug": "young-sheldon-2017", "title": "Young Sheldon (2017) - Series",
    "type": "series", "season": 7, "episode": 14, "rating": 7.6 }
]}
```

`lib/sources/movies.js` splits the response:
- `search(q)` → keeps `type === 'movie'`, returns movie-shaped cards.
- `searchSeries(q)` → keeps `type === 'series'`, returns series-shaped cards (also upserted into the local `series` table so future offline searches work).

The facade's `search()` (`lib/index.js`) combines `movieSource.search` + `movieSource.searchSeries` + `seriesSource.search` (local-DB fallback) and dedupes by slug.

---

## 3. Detail scraping

### Movies

```
GET http://<active-host>/<slug>/
```

Metadata comes from the JSON-LD `Movie` block. Three fallback checks detect pages that are actually series:

1. HTTP redirect to a different host → the source redirected to nontondrama.
2. JS countdown markup (`#openNow` or `main.card`) → series interstitial.
3. `@type: TVSeries` in JSON-LD.

Any hit → the slug is removed from the movies table and the API returns `{ isSeries: true }` so the frontend hands off to `openSeries`.

### Series

```
GET https://tv3.nontondrama.my/<slug>-<year>
```

Series detail pages inline two JSON blocks we read directly:

```html
<script id="watch-history-data" type="application/json">
  {"id":…, "title":…, "rating":…, "total_eps":…, "total_season":…, "poster":…, "year":…}
</script>

<script id="season-data" type="application/json">
  {"1":[{"s":1,"episode_no":1,"title":"…","slug":"…-season-1-episode-1-2023"},…], "2":[…]}
</script>
```

Plus JSON-LD `TVSeries` for description / director / cast / genre.

**HTML-entity quirk**: the inline JSON sometimes contains `&#039;` (HTML-encoded apostrophe) inside string values — valid JSON, but when `textContent` on the frontend prints it back the entity displays literally. `series.js` runs `decodeEntities()` on every scraped text field after `JSON.parse()` to fix this.

---

## 4. Player resolution

Upstream now ships `data-url` in two formats. `lib/resolver.js::resolvePlayers(rawPlayers, { referer, origin, pageUrl })` splits the list by format and routes each through its own path.

| Format                | Example                                       | Path                                                |
|-----------------------|-----------------------------------------------|-----------------------------------------------------|
| Legacy plain URL      | `https://playeriframe.sbs/iframe/cast/abc123` | HTTP fetch + inner-iframe extract (`resolveInnerUrl`) |
| Encrypted token (Nov 2026+) | `YuvLljMYIlUgNITzceX+NKlGMbWCwksz…` (base64 AES-CBC ciphertext) | Headless Chromium runs upstream's own JS to decrypt   |

### Encrypted-token flow (jsdom)

Upstream replaced their `playeriframe.sbs` URLs with AES-CBC ciphertext, decrypted client-side by a heavily obfuscated `obfuscator.io`-VM-style `player.js` (their script ships its own bytecode interpreter; constant strings live as base64-marshalled blobs in the bytecode stream). Static deobfuscation isn't worth it — they regenerate the VM on each release.

But the obfuscator exposes the decrypt routine as a *public symbol* on a `vmX_<hex>` global (because their own click handlers need to call it). So we load their `player.js` in a tiny jsdom sandbox, find that function by behavior, and call it directly. `lib/decrypt.js`:

1. Fetches `player.js` + `script.js` from upstream once, caches the source in SQLite for 6 h (TTL — picks up upstream rotations).
2. Builds a single jsdom instance, evaluates the two scripts.
3. Scans every function on every `vmX_*` global, calls each with the first token we need to decrypt; the one that returns a string starting with `https://` is the decrypt fn. Cached for the rest of the process lifetime (refreshed every 6 h, or on explicit invalidate).
4. Decryption is then a synchronous function call: `decrypt(token) → "https://playeriframe.sbs/iframe/<player>/<id>"`.
5. The wrapper URL is fed through the legacy `resolveInnerUrl` path below to get the deep embed URL.

Caching keeps the decrypt sandbox off the hot path even more:

- Per-token cache in `response_cache` (key `player:<encrypted-token>`, TTL 12 h). A movie's tokens are looked up first in cache; the decrypt sandbox only runs on a miss.
- The detail-page response is independently cached for 30 min by `lib/cache.js`.

**Performance:** cold init (fetch upstream scripts + build jsdom + discover fn) ~280 ms. Per-token decrypt ~0.25 ms. Cold scrape end-to-end ~1.2 s, dominated by the source-site HTML fetch — not by decryption. Warm cache: 0 ms.

If upstream rotates the AES key, cached URLs may stop working — iframe just fails to load, the frontend's "try next player" fallback kicks in, and the bad entry ages out of cache in ≤12 h. The decrypt sandbox itself self-refreshes on the next 6 h tick (or sooner if resolution starts failing — `invalidateInit()` forces a re-fetch). No code change required.

If they ever stop exposing the decrypt fn publicly (unlikely — their own page needs it), `discoverDecryptFn` returns null and the resolver falls back to the proxy path.

### Legacy plain-URL flow

For any plain `playeriframe.sbs` URL still seen in the markup (`resolveInnerUrl`):

1. Fetch the wrapper server-side with source-site Referer/Origin headers.
2. Extract the inner `<iframe src>` from the wrapper page (skipping 1×1 Cloudflare challenge iframes).

### Common post-resolution

For both flows:

3. If resolution fails, set `finalUrl` to `/api/proxy?url=<original-src>` as a fallback — our proxy re-injects the spoof script and strips CSP headers so the iframe renders inside our domain.
4. Drop P2P (`cloud.hownetwork.xyz`) entirely — it's behind Cloudflare JS challenges and hostname checks that can never be satisfied server-side.

The frontend gets pre-resolved `finalUrl` values, so clicking a player tab is instant — no round-trip.

---

## 5. Bypassing anti-scraping

### UA + Referer

Source servers reject bot-like UAs. We send a realistic Chrome UA everywhere (`lib/http.js::DEFAULT_HEADERS`), plus site-appropriate `Referer`/`Origin` on player-wrapper requests.

### CSP `frame-ancestors` on inner players

Some inner players (e.g. `emturbovid.com`) set `Content-Security-Policy: frame-ancestors` that blocks embedding. Our resolver HEADs the final URL first; if CSP is present, the URL is routed through `/api/proxy` which fetches the HTML server-side, strips the CSP header, and injects a referrer-spoof + ad-blocker script before sending it back.

### Cloudflare JS challenge on player backends

Backends like `short.icu` (HYDRAX), `abysscdn.com`, and `cloud.hownetwork.xyz` (P2P) are protected by Cloudflare's JS challenge. We don't try to solve it; we embed the CAST/HYDRAX/TURBOVIP URLs directly in an `<iframe>` in the user's real browser, which can solve the challenge natively. Only the wrapper-resolution step happens server-side.

### `document.referrer` checks

Some players read `document.referrer` at runtime. Our proxy injects a property override so `document.referrer` returns the source-site origin:

```js
Object.defineProperty(document, 'referrer', {
  get: () => 'https://<active-host>/',
  configurable: true,
});
```

### Encrypted player tokens

Upstream's `obfuscator.io`-VM `player.js` decrypts AES-encrypted player URLs client-side. We don't reverse the obfuscation — we run it (in jsdom, not a real browser). See Section 4 for the flow.

### Source host rotation

The movie site rotates subdomains (`tv10` → `tv11` → …) and occasionally TLDs (`lk21official.cc` → `lk21.party`). `lib/sources/movies-host.js` keeps a candidate list, probes them on startup, caches the active host, and silently rotates on network failure (ECONNREFUSED / ENOTFOUND / timeout / ECONNRESET).

---

## 6. What we can't bypass

| Barrier                                       | Reason                                                      |
|-----------------------------------------------|-------------------------------------------------------------|
| Cloudflare JS challenge on inner player hosts | Requires a real browser to solve — we serve direct iframes  |
| Hostname verification inside player JS        | `window.location` is only accurate when the player is embedded directly, not proxied through our domain |
| Video-playback progress                       | Cross-origin iframes hide all media events — "Recently Watched" shows opens, not completions |
| P2P player                                    | Cloudflare JS challenge + hostname checks are unbeatable server-side — dropped from the player list |

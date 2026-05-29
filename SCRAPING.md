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
    ├─ lib/resolver.js: opaque token / playeriframe.sbs wrapper → inner player URL
    └─ lib/decrypt.js : XOR-decoder — turns opaque tokens into playeriframe.sbs wrapper URLs

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

## 4. Player resolution — the XOR token decode

Player URLs aren't on the source page directly — they're opaque tokens. But despite first appearances, resolving them needs no network round-trip at all: each token is a base64-wrapped XOR ciphertext, and the upstream's own `player.js` decodes them client-side with a hardcoded key. We mirror the same decode in Node.

### What the source page actually contains

Player tabs are `<a data-url>` rows (mirrored into a `<select>` for the mobile dropdown) with opaque values:

```html
<ul id="player-list">
  <li><a data-url="JB9GQSBPRFwVHzIcCRMFEzgAFARkEhsSZQgfE0AhDh1BYQVERQBEZlIOA1tDfVAdVHMFHAd8A05XR3gNVAZlQ19CVko=" data-server="p2p">P2P</a></li>
  <li><a data-url="JB9GQSBPRFwVHzIcCRMFEzgAFARkEhsSZQgfE0AhDh1FJgcJHBMaI0ojVjw6eyYYL3gwNVMgCQ0SRi46Qw==" data-server="turbovip">TURBOVIP</a></li>
  <li><a data-url="JB9GQSBPRFwVHzIcCRMFEzgAFARkEhsSZQgfE0AhDh1SMgYfXAIaIVIAGBUYcwpOFQ==" data-server="cast">CAST</a></li>
  <li><a data-url="JB9GQSBPRFwVHzIcCRMFEzgAFARkEhsSZQgfE0AhDh1ZKhEZEh1cFScIMl0dLwNI" data-server="hydrax">HYDRAX</a></li>
</ul>
```

Each `data-url` is `base64(plaintext ⊕ KEY repeating)` where the plaintext is a `playeriframe.sbs/iframe/<vendor>/<id>` URL.

### The decode

The in-browser `player.js` (`https://assets.showcdnx.com/js/player.js`) shows the whole protocol in eight lines:

```js
function doChallengeAndLoad(e) {                            // the name is misleading — no challenge anymore
  var t = document.getElementById("main-player"),
      a = "",
      o = "Lk21SuksesSelaluJayaJayaJaya!";                 // 29-byte XOR key, hardcoded
  e = atob(e);                                              // base64 → raw bytes
  for (var l = 0; l < e.length; l++)
    a += String.fromCharCode(e.charCodeAt(l) ^ o.charCodeAt(l % 29));
  t.src = a;                                                // direct iframe src
}
```

(Earlier rotations of `player.js` did use a server-side proof-of-work challenge at `sinta.{rootDomain}` — hence the function name. The `sinta` endpoints may still exist but are no longer wired into the page.)

### Implementation

`lib/decrypt.js` is a pure synchronous function. Per token:

1. `Buffer.from(token, 'base64')` → raw bytes.
2. XOR each byte with `XOR_KEY.charCodeAt(i % XOR_KEY.length)` to recover the plaintext URL.
3. Sanity-check the result starts with `http://` or `https://` and return it (or `null` for junk input).

No network call, no PoW, no fingerprinting. The returned wrapper URL is then handed to `resolveInnerUrl` (HTTP fetch + parse out the inner `<iframe src>`) to get the deep embed URL like `https://emturbovid.com/t/...`.

**Caching:**

- `player:<token>` (TTL 12 h) — caches the *inner* embed URL (the result of `resolveInnerUrl` on top of the XOR-decoded wrapper). The XOR step itself is so cheap (microseconds) that caching just the wrapper would be pointless; the value is the avoided HTTP fetch of `playeriframe.sbs`.
- The detail-page response cache (30 min) layered on top means the whole movie scrape often skips the source-site fetch too.

### Performance

| Stage | Time |
|---|---|
| XOR decode per token | <1 ms |
| `playeriframe.sbs` wrapper fetch (`resolveInnerUrl`) | ~150–250 ms |
| Per-token total (cold) | ~200 ms |
| Per-token total (warm cache hit) | 0 ms |
| Cold scrape end-to-end (uncached movie, all tokens in parallel) | ~600–900 ms |

The hard cost is the wrapper HTTP fetch, not the decode. Tokens are decoded synchronously in a single tick; the wrapper fetches all run in parallel via `Promise.all`.

### When this breaks (and what we do about it)

| Failure mode | Effect | Recovery |
|---|---|---|
| Upstream rotates the XOR key (changes the string in `player.js`) | Every token decodes to garbage; the http(s) sanity check rejects them all and returns null | Fetch the live `player.js` (`https://assets.showcdnx.com/js/player.js`), find the `o = "..."` literal inside `doChallengeAndLoad`, update `XOR_KEY` in `lib/decrypt.js` |
| Upstream switches scheme entirely (e.g. back to a server PoW, or a different cipher) | Tokens stop decoding; the http(s) sanity check rejects them | Re-read `player.js` and re-implement whatever `doChallengeAndLoad` (or its successor) does |
| Upstream changes container element selectors (`#player-list`, `#player-select`) | `rawPlayers` ends up empty in `lib/sources/movies.js` before decode even runs | Update the cheerio selectors in `getMovie`/`getEpisode` |
| Upstream returns a wrapper URL that's not `playeriframe.sbs` | `resolveInnerUrl` doesn't recognize it | Wrapper is passed through as-is (see `resolveEncrypted` in `lib/resolver.js`); usually still embeddable |

### Legacy plain-URL flow

A handful of older pages still ship plain `playeriframe.sbs` URLs in `data-url` instead of opaque tokens. For those, `resolveInnerUrl` HTTP-fetches the URL and extracts the deep `<iframe src>` directly. No challenge round-trip. Same final step as the token flow — the two paths converge before caching.

### Common post-resolution

For both flows:

- If resolution fails for a **plain-URL** src, route it through `/api/proxy?url=<original-src>` — our proxy fetches the wrapper server-side, strips CSP headers, and injects a referrer-spoof so the iframe renders inside our domain.
- If resolution fails for an **opaque token** (the XOR decode produced something that isn't a URL), the player tab is dropped — there's no URL to proxy and rendering `/api/proxy?url=<token>` would just yield an "Invalid URL" 400 from the SSRF guard.
- Drop P2P (`cloud.hownetwork.xyz`) entirely — it's behind Cloudflare JS challenges and hostname checks that can never be satisfied server-side.

The frontend ends up with pre-resolved `finalUrl` values, so clicking a player tab is instant — no round-trip.

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

### Opaque player tokens

Player tabs ship as opaque IDs that XOR-decode (with a hardcoded key lifted from upstream's `player.js`) to `playeriframe.sbs` wrapper URLs. We mirror the in-browser decode in pure Node. See Section 4 for the protocol.

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

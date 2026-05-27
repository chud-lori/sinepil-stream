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
    └─ lib/decrypt.js : sinta.{root} PoW client — resolves opaque tokens to wrapper URLs

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

## 4. Player resolution — the sinta PoW challenge

This is the most adversarial part of the scrape. Player URLs aren't on the source page directly — they're opaque tokens. Resolving each token to a real embed URL means clearing upstream's anti-scraping gate: a server-side **proof-of-work challenge** at `sinta.{rootDomain}`.

### What the source page actually contains

Player tabs are `<select><option>` rows with opaque values:

```html
<select id="player-select">
  <option value="Mn6nHibKcYtQowT6wLx6lcX2H00ooz2MpEErEf8I6ilR0JzFz1V…" data-server="p2p" selected>GANTI PLAYER P2P</option>
  <option value="PSzpT0pXpnWi51pfOqLnx1KlkxpMQ-JMkCNZJnQ5RdaZMG0ryc…" data-server="turbovip">GANTI PLAYER TURBOVIP</option>
  <option value="o9CgGizrxsfn-UNEVzDETfUw9v_8A6W4EYowXs2S4EqeUNymhn…" data-server="cast">GANTI PLAYER CAST</option>
  <option value="_ppVQw-PIJpg-KAHnEeLNXYumNT59SeJDj9eWLeaIY_KX2fijd…" data-server="hydrax">GANTI PLAYER HYDRAX</option>
</select>
```

The values are opaque IDs — they're not URLs, not base64-encoded ciphertext, not anything we can decode locally. They're just keys upstream looks up server-side after we prove we can do real work.

### The handshake

The in-browser `player.js` reveals the protocol:

```js
function doChallengeAndLoad(e) {
  var t = "https://sinta." + getRootDomain(window.location.href);   // sinta.lk21official.cc
  sendXHR({ url: t + "/challenge.php?id=" + encodeURIComponent(e), method: "GET",
    success: function (r) {
      if (r.trusted && r.url) {                                      // some tokens skip PoW
        a.src = r.url;
      } else {
        solvePow(r.challenge, r.difficulty, function (nonce) {       // SHA-256 hashcash
          sendXHR({ url: t + "/verify.php", method: "POST",
                    data: { challenge: r.challenge, nonce, id: e, fp: getFingerprint() },
                    success: function (v) { a.src = v.url; } });
        });
      }
    }
  });
}
```

Three calls:

1. **`GET sinta.{root}/challenge.php?id={token}`** → `{ challenge, difficulty }` (a hex string + N).
2. **PoW** — find a nonce such that `SHA-256(challenge + nonce)` starts with `difficulty` hex zeros.
3. **`POST sinta.{root}/verify.php`** with JSON `{ challenge, nonce, id, fp }` → `{ url: "https://playeriframe.sbs/iframe/<player>/<id>" }`.

`sendXHR` uses `Content-Type: application/json` for POSTs — sending the verify body form-encoded gets a generic `"Invalid request"` 200 back. The fingerprint is a 5-field pipe-joined string built from `navigator.userAgent | platform | screen.WxH | tz-offset | hardwareConcurrency`. The server reads it but doesn't strictly validate values — anything plausibly-shaped passes.

### Implementation

`lib/decrypt.js` is a thin pure-Node client. Per token:

1. Derive `sinta.{root}` from the scrape's referer (`getRootDomain` returns the last two hostname labels: `tv10.lk21official.cc` → `lk21official.cc`).
2. `axios.get` `challenge.php`. If `trusted && url`, skip PoW.
3. Spin `crypto.createHash('sha256').update(challenge + nonce).digest('hex')` in a tight loop until prefix matches. Capped at `POW_MAX_ITERATIONS` (16 M) so a difficulty spike can't hang the request.
4. `axios.post` `verify.php` as JSON. Return `verify.url` or `null`.

All tokens for a movie are resolved in parallel via `Promise.all`. The returned wrapper URL is then handed to `resolveInnerUrl` (HTTP fetch + parse out the inner `<iframe src>`) to get the deep embed URL like `https://emturbovid.com/t/...`.

**Caching:**

- `player:<token>` (TTL 12 h) — verify returns the same wrapper URL for the same token across requests; cache the wrapper.
- The detail-page response cache (30 min) layered on top means the whole movie scrape often skips the source-site fetch too.

### Performance

| Stage | Time |
|---|---|
| `challenge.php` round-trip | ~50–80 ms |
| PoW solve at difficulty 4 (~32 k SHA-256 hashes) | ~70 ms |
| `verify.php` round-trip | ~50–80 ms |
| Per-token total (cold) | ~200 ms |
| Per-token total (warm cache hit) | 0 ms |
| Cold scrape end-to-end (uncached movie, all tokens in parallel) | ~600–900 ms |

Higher PoW difficulty scales roughly 16× per step: difficulty 5 ≈ ~1 s, difficulty 6 ≈ ~18 s. The cap (`POW_MAX_ITERATIONS = 16 M`) gives ~30 s wall time worst-case before a token is dropped.

### When this breaks (and what we do about it)

| Failure mode | Effect | Recovery |
|---|---|---|
| Upstream rotates root domain (`lk21official.cc` → new TLD) | `sinta.<oldRoot>` stops resolving; tokens return null | `lib/sources/movies-host.js` failover already updates the active host; `rootDomainFromReferer` derives the new `sinta.{root}` automatically |
| Upstream raises PoW difficulty past 5–6 | Solve time blows past the iteration cap; tokens return null | Bump `POW_MAX_ITERATIONS` if the wait is acceptable, or move the PoW into a worker thread to keep the event loop responsive |
| Upstream changes the challenge format (different hash, different prefix encoding) | All tokens return null | Inspect upstream's `solvePow` in the live `player.js`; update `solvePow()` in `lib/decrypt.js` |
| Upstream rejects our requests (rate limit, fingerprint heuristics) | `challenge.php` 4xx or `verify.php` returns `success: false` | Throttle, randomise fingerprint, or proxy through a residential IP |
| Upstream returns a wrapper URL that's not `playeriframe.sbs` | `resolveInnerUrl` doesn't recognize it | Wrapper is passed through as-is (see `resolveEncrypted` in `lib/resolver.js`); usually still embeddable |

### Legacy plain-URL flow

A handful of older pages still ship plain `playeriframe.sbs` URLs in `data-url` instead of opaque tokens. For those, `resolveInnerUrl` HTTP-fetches the URL and extracts the deep `<iframe src>` directly. No challenge round-trip. Same final step as the token flow — the two paths converge before caching.

### Common post-resolution

For both flows:

- If resolution fails for a **plain-URL** src, route it through `/api/proxy?url=<original-src>` — our proxy fetches the wrapper server-side, strips CSP headers, and injects a referrer-spoof so the iframe renders inside our domain.
- If resolution fails for an **opaque token** (the PoW handshake failed), the player tab is dropped — there's no URL to proxy and rendering `/api/proxy?url=<token>` would just yield an "Invalid URL" 400 from the SSRF guard.
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

Player tabs ship as opaque IDs that resolve to wrapper URLs only after clearing upstream's `sinta.{root}` proof-of-work gate. We mirror the in-browser handshake in pure Node — challenge → SHA-256 hashcash → verify. See Section 4 for the protocol.

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

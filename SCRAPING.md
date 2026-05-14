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

## 4. Player resolution — bypassing the AES encryption

This is the most adversarial part of the scrape. Around Nov 2026 upstream started shipping every player URL as AES-CBC ciphertext, decrypted client-side by a heavily obfuscated `player.js`. Without that decryption the API returns `players: []` and the UI shows *"No player sources found."*

This section walks through how SinepilStream gets past it without running a real browser — including the byte-level evidence and the structural quirk in the obfuscator that opened the door.

### What changed

The source page's player tabs used to look like this:

```html
<a data-url="https://playeriframe.sbs/iframe/cast/abc123" data-server="CAST">CAST</a>
```

That's a plain HTTP URL — we'd fetch it server-side and pull out the inner `<iframe src="…">`. Easy.

Now they look like this:

```html
<a data-url="YuvLljMYIlUgNITzceX+NKlGMbWCwksz…" data-server="CAST">CAST</a>
```

A base64-encoded blob. The plain URL is produced inside the browser by an obfuscated `player.js` decrypting the blob and assigning the result to `iframe.src`. Server-side, we never see the real URL — only the ciphertext.

### Step 1 — confirm the algorithm

Before picking an approach, we needed to know what kind of crypto we're up against. Base64-decoded a handful of tokens from the *same* page and dumped the raw bytes side-by-side:

```
Token A (P2P):       62eb cb96 3318 2255 2034 84f3 71e5 fe34  a946 31b5 82c2 4b33 34c8 4734 f01b 0708  5b86 …
Token B (TURBOVIP):  62eb cb96 3318 2255 2034 84f3 71e5 fe34  a946 31b5 82c2 4b33 34c8 4734 f01b 0708  fxVDY …
Token C (CAST):      62eb cb96 3318 2255 2034 84f3 71e5 fe34  a946 31b5 82c2 4b33 34c8 4734 f01b 0708  Ixl …
```

Every token shares the *exact same first 32 bytes*. In AES-CBC with a fixed key + fixed IV, ciphertext block N is identical across messages iff plaintext blocks 1..N are identical. So plaintext blocks 1 and 2 (32 bytes total) are identical across all tokens — overwhelmingly likely to be the literal string `https://playeriframe.sbs/iframe/` (which is exactly 32 chars). The variable bytes after byte 32 are the per-player path (`cast/abc123` vs `turbovip/def456` etc.).

So: **AES-CBC, fixed IV, layout `[ enc(p1) | enc(p2) | enc(p3) | … ]`**.

This rules out a key-recovery attack — known-plaintext doesn't break AES. We'd need the key, and that lives somewhere inside the obfuscated `player.js`.

### Step 2 — is there an HTTP shortcut?

The cheapest possible bypass would be a server-side decrypt endpoint we could just call. Loaded the source page in puppeteer with `page.on('request')` logging every URL + POST body during player tab clicks. Result: **no request anywhere carries the token or any fragment of it.** Decryption is 100% client-side. No shortcut.

### Step 3 — static deobfuscation vs running their JS

Two viable ways to get a server-side decrypt:

1. **Static** — parse `player.js`, dump its constants, reconstruct the AES key + IV, write a 20-line decrypt in pure Node.
2. **Dynamic** — run `player.js` in a JS environment and let it decrypt for us.

`player.js` is `obfuscator.io`-VM-style. It ships its own bytecode interpreter (`vmU_<hex>`) with constants stored as base64-marshalled blobs:

```js
let p = ["AQgAAQAAAAoMCBJfMHgzOGIyNDU…", "AQAIAQACFDwEAAgSXzB4MzhiMjQ1…"];
```

Static deobfuscation would mean reimplementing the VM byte-for-byte — multi-day work that rots on every upstream regen (the `?v=4` cache-buster on their script URL is the giveaway that they iterate often). Dynamic execution adapts automatically. Pick (2).

The naive way to do (2) is headless Chromium — it works, but costs ~190 MB of Chrome binary, ~250 MB peak RAM, and ~3-5 s cold scrape. So we looked for something lighter.

### Step 4 — the opening: a public symbol

The obfuscator hides the VM's *internals*, but the page itself contains plain JS that calls into the VM. Scrolled to the tail of `player.js`, past all the obfuscated junk, and found the part that wires up DOM event handlers:

```js
for (var c = document.querySelectorAll("#player-list a"), f = 0; f < c.length; f++)
  c[f].addEventListener("click", function (e) {
    e.preventDefault();
    var t = _L(this.dataset.url),     // ← decrypt happens here
        r = document.getElementById("main-player");
    r.src = t;
    …
  });
```

`_L` is referenced as a **bare global identifier**. The obfuscator has to expose its decrypt function publicly so the page's own non-obfuscated handlers can call it. Sure enough, after loading `player.js` in any JS runtime, both of these exist:

```
globalThis._L                  = <fn>             // direct global, present on every version we've seen
globalThis.vmz_8c3fe5          = { _L: <fn>, … }  // also exposed on a namespace; the prefix (vmX_, vmz_, …) rotates
```

`_L` is the decrypt function. We don't need to reverse the obfuscation. We just need to call `_L`.

### Step 5 — implementation: jsdom + dynamic discovery

`lib/decrypt.js`:

1. Fetch `player.js` + `script.js` from upstream's CDN once. Cache the source in SQLite (`upstream-script:*`, TTL 6 h — picks up upstream rotations automatically). The CDN host + version pin in the URL change a couple of times a year (`assets.lk21.party/?v=4` → `assets.showcdnx.com/?v=8` in Nov 2026); when discovery starts failing for everyone, that's usually the cause — bump the two URL constants in `lib/decrypt.js`.
2. Build a single jsdom instance with a minimal DOM stub (`<ul id="player-list">`). Evaluate both scripts inside it.
3. **Dynamic discovery:** try `window._L` first (stable across versions); if it doesn't return a URL, scan every property of every `vm[A-Za-z]_<hex>` namespace on `window`, call each function with the first encrypted token we need, and pick the one that returns a string starting with `https://`. Cache the reference for the process lifetime.
4. Decryption is now a synchronous function call: `decrypt(token) → "https://playeriframe.sbs/iframe/<player>/<id>"`.
5. The decrypted wrapper URL is fed through `resolveInnerUrl` (HTTP fetch + parse out the inner `<iframe src>`) to get the deep embed URL like `https://emturbovid.com/t/...`.

**Why dynamic discovery (instead of hardcoding `vmz_8c3fe5._L`):** all of those names are randomized on every obfuscation pass. We've seen the namespace prefix rotate (`vmX_` → `vmz_`) and the hex suffix and inner function name change with it. The *behavior* — a function on a `vm*_<hex>` namespace that decrypts a token to a URL — has stayed constant, and `globalThis._L` is exposed on every version we've encountered.

**Caching layers keep the sandbox cold most of the time:**

- `player:<encrypted-token>` (TTL 12 h) — once we've decrypted a token, we don't decrypt it again for 12 h.
- The detail-page response cache (30 min) layered on top means the whole movie scrape often skips the source-site fetch too.

### Performance

| Stage | Time |
|---|---|
| jsdom init + upstream-script fetch + decrypt-fn discovery | ~280 ms (once per 6 h) |
| Per-token decrypt | ~0.25 ms |
| Cold scrape end-to-end (uncached movie) | ~1.2 s (dominated by source-site HTML fetch) |
| Warm cache hit | 0 ms |

Compared to a headless-Chromium approach: same warm performance, **~4× faster cold, ~200 MB less disk, ~200 MB less peak RAM**.

### When this breaks (and what we do about it)

| Failure mode | Effect | Recovery |
|---|---|---|
| Upstream regenerates `player.js` (new VM names) | Cached scripts go stale | Auto re-fetch every 6 h; `invalidateInit()` forces a refresh sooner and also drops the cached script bodies |
| Upstream moves to a new CDN or bumps the `?v=` query (e.g. `assets.lk21.party/?v=4` → `assets.showcdnx.com/?v=8`) | Old URL still serves a working-but-mismatched script; discovery finds `_L` but it returns garbage for the new tokens | Update `PLAYER_JS_URL` / `SCRIPT_JS_URL` in `lib/decrypt.js` |
| Upstream rotates the AES key | Cached decrypted URLs stop working | Iframe load error → frontend tries the next player → bad entry ages out of cache in ≤12 h |
| Upstream stops exposing the decrypt fn publicly (unlikely — their own click handlers depend on it) | `discoverDecryptFn` returns null | Resolver falls back to the proxy path for the encrypted token. Player tab will likely fail to play, rest of the site stays up |
| Algorithm change (e.g. they swap AES for something else) | Discovery still works as long as the new fn outputs `https://…` strings | Auto-adapts |
| `player.js` starts depending on a browser API jsdom doesn't have | Discovery fails at init | Need to either polyfill the missing API or fall back to a real browser |

### Legacy plain-URL flow

A handful of older pages still ship plain `playeriframe.sbs` URLs in `data-url` instead of encrypted tokens. For those, `resolveInnerUrl` HTTP-fetches the URL and extracts the deep `<iframe src>` from the response. No decryption needed. Same final step as the encrypted-token flow — the two paths converge before caching.

### Common post-resolution

For both flows:

- If resolution fails entirely, set `finalUrl` to `/api/proxy?url=<original-src>` as a fallback — our proxy fetches the wrapper server-side, strips CSP headers, and injects a referrer-spoof so the iframe renders inside our domain.
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

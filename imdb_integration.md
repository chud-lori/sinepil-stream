# IMDb Integration — Plan & Execution

## Goal

Add `streamimdb.ru` as a third upstream alongside the existing lk21 (movies) and nontondrama (series) sources. Use the IMDb ID as the canonical movie/series identifier so the same title indexed across multiple sources renders as a single card with combined player tabs.

## Why this matters

- Larger catalog: streamimdb indexes titles lk21/nontondrama don't carry.
- Extra player fallback per title (`IMDB` tab) for cases where existing players are geo-blocked or rate-limited.
- IMDb ID as canonical key sets us up to cleanly absorb future sources without per-source plumbing each time.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Scope | All phases (catalog + player + dedup + URL input) |
| URL routing | Option B — keep existing `:slug` URLs; server resolves `slug → imdbId → all sources` and fans out |
| IMDB player priority | Last (fallback) until embedding is verified |
| `imdb_id` in API responses | Yes — surfaced on `/api/movie/...` and `/api/episode/...` |
| One PR per phase | Yes (standing rule) |

## Architecture

```
            ┌─────────────────────────────────────────────┐
            │  Catalog endpoints (latest/search/category) │
            └────────────────────┬────────────────────────┘
                                 │
                       ┌─────────▼─────────┐
                       │  Aggregator       │  ← parallel fan-out
                       │  + dedup by tt-id │
                       └─────────┬─────────┘
            ┌────────────────────┼────────────────────┐
            │                    │                    │
    ┌───────▼──────┐    ┌────────▼──────┐    ┌────────▼─────────┐
    │ movies.js    │    │ series.js     │    │ streamimdb.js    │
    │ (lk21)       │    │ (nontondrama) │    │ (new)            │
    └──────┬───────┘    └───────┬───────┘    └────────┬─────────┘
           │                    │                     │
           │ scrape             │ scrape              │ scrape (IMDb ID
           │ title+year         │ title+year          │ already on detail)
           ▼                    ▼                     ▼
    ┌────────────────────────────────────────────────────────────┐
    │  lib/imdb.js — resolveImdbId({title,year,kind,sourceSlug}) │
    │  cached forever (incl. null misses)                        │
    └────────────────────────────────────────────────────────────┘
```

Detail endpoint flow (Option B):

```
GET /api/movie/:slug
      │
      ├─→ Look up slug in source registry (lk21/nontondrama/streamimdb)
      ├─→ Get this slug's imdbId (cached)
      ├─→ Reverse lookup: which other sources have this imdbId?
      ├─→ Fan out scrape to all sources with this imdbId (parallel)
      └─→ Merge metadata + concat player sources → respond
```

## Execution plan (PR-by-PR)

### PR 1 — `lib/imdb.js` (resolution + cache)

**Files:** `lib/imdb.js` (new), `lib/cache.js` (audit/extend if needed)

- Implement `resolveImdbId({title, year, kind, sourceSlug}) → tt-id | null`
- Primary lookup: IMDb autocomplete JSON
  - `https://v3.sg.media-imdb.com/suggestion/{firstLetter}/{slug}.json`
  - Disambiguate by year (`y`) and kind (`q` ∈ `feature`/`tvSeries`/`tvMiniSeries`)
- Fallback: scrape `https://www.imdb.com/find/?q={title}+{year}&s=tt` HTML
- Cache key: `imdb:{source}:{sourceSlug}` → `tt-id` or `null`
- TTL: effectively infinite (slug→IMDb mapping is immutable). Cache nulls too.
- Audit `lib/cache.js`: if in-memory only, add persistence (file or sqlite) so resolutions survive restarts.

**Acceptance:** unit-tested standalone. No behavior change elsewhere.

---

### PR 2 — Streamimdb as a player tab on existing titles

**Files:** `lib/resolver.js`, `public/app.js` (`sortPlayers`), `server.js`

- After existing player resolution in `resolvePlayers(...)`:
  - Call `resolveImdbId(...)` for the title
  - On hit, append:
    - Movie: `{ label:'IMDB', finalUrl:'https://streamimdb.ru/embed/movie/{tt}', proxied:false }`
    - Episode: `{ label:'IMDB', finalUrl:'https://streamimdb.ru/embed/tv/{tt}/{S}/{E}' }`
- Extend `sortPlayers` PRIORITY: add `'IMDB'` last.
- `/api/movie/...` and `/api/episode/...` responses gain `imdb_id` field.
- Graceful no-op when IMDb resolution returns null — tab simply absent.

**Validation gate:** confirms in production
- (a) IMDb resolution works at scale (latency, hit-rate)
- (b) streamimdb embedding isn't ancestorOrigins-blocked on our domain.

If (b) fails: IMDB player tab is useless, but catalog/dedup value (PR 3+) remains. Proceed regardless.

---

### PR 3 — `lib/sources/streamimdb.js` (catalog scraper)

**Files:** `lib/sources/streamimdb.js` (new), `lib/sources/scrub.js` (extend if needed)

- Listing scrape:
  - Homepage / `/category/*` / `/search?q=` → list of items
- Detail scrape:
  - `/movie/{slug}` or `/tv/{slug}` → metadata + extract IMDb ID directly from page (no IMDb API call needed for this source)
- Output shape matches `movies.js` / `series.js`:
  ```js
  { slug, title, year, poster, genre, rating, kind, source: 'streamimdb', imdbId }
  ```
- **Not yet wired** into any API endpoint — module exists, no user-visible change.

**Verification needed at PR-start:** confirm streamimdb's detail page exposes IMDb ID in scrapeable HTML (link to imdb.com, or JSON-LD, or meta tag).

---

### PR 4 — `lib/aggregator.js` (listings dedup)

**Files:** `lib/aggregator.js` (new), `server.js` (wire into listing endpoints)

- Fan out to all enabled sources in parallel.
- Resolve `imdbId` for every item:
  - streamimdb items: skip lookup (already have it from PR 3 detail scrape)
  - lk21/nontondrama items: call `resolveImdbId(...)` (uses PR 1 cache)
- Group by `imdbId`:
  - Merge metadata (richest poster wins; longest description; union of genres)
  - Concatenate per-source `players` arrays (preserving source priority)
  - Items with `imdbId === null` stay distinct (no dedup possible)
- Sort/paginate **after** dedup.
- Wire into listing endpoints (`/api/latest`, `/api/search`, `/api/browse`, etc.).

**Performance considerations:**
- Cold-cache cost: ~24 items × ~200ms IMDb lookup = ~5s worst case.
- Mitigation strategy (pick one after measuring):
  - **Async fill**: return items immediately without imdb-id; client re-fetches; dedup applied on subsequent render.
  - **Background pre-warm**: scheduled job warms cache for popular/recent items.
  - **Batched parallel**: 5–10 concurrent lookups (default IMDb endpoint tolerates this).

---

### PR 5 — Detail endpoint fan-out (Option B)

**Files:** `server.js` (`/api/movie/:slug`, `/api/series/:slug`, `/api/episode/...`), `lib/aggregator.js` (extend)

- `:slug` lookup flow:
  1. Identify source by slug shape / source registry.
  2. Get this slug's `imdbId` (via cache; falls back to scrape if cold).
  3. Reverse-lookup: `imdbId → [{source, slug}]` (new reverse cache).
  4. Fan-out scrape to all sources with this imdbId in parallel.
  5. Merge metadata; concat players.
- New reverse cache: `imdb-reverse:{tt-id}` → `[{source, slug}]`. Populated as a side-effect of PR 1 resolutions and PR 3 streamimdb scrapes.
- Existing URLs keep working. New shape additions:
  - Response gains `imdb_id` and `sources: ['lk21', 'streamimdb', ...]` for transparency.

---

### PR 6 — "Watch by URL" accepts IMDb URL / ID

**Files:** `server.js` (`/api/slug-from-url`), `public/index.html` (placeholder text), `public/app.js` (URL input handler + label)

**Server (`/api/slug-from-url`):** extend `scraper.fromSourceUrl(...)` to also recognise:
- Bare IMDb ID: `tt0111161`
- `https://www.imdb.com/title/tt0111161/...`
- `https://www.imdb.com/title/tt0111161/?ref_=...` (strip query)
- `https://playimdb.com/title/tt0111161/...`
- `https://streamimdb.ru/embed/movie/tt0111161` / `/embed/tv/tt.../S/E`

Recognition logic:
```js
const m = url.match(/\b(tt\d{7,9})\b/);  // matches any tt-id anywhere in input
if (m) {
  const imdbId = m[1];
  // Reverse-lookup cache (from PR 5): does any source have this?
  // If yes → return canonical slug → frontend opens by slug (Option B)
  // If no  → return { kind, imdbId } → frontend opens by imdb-id directly
}
```

**Frontend changes:**
- Placeholder: `"Paste a lk21/nontondrama/IMDb link or IMDb ID (tt7888964)…"`
- Label stays "Watch by URL"
- If response has `slug` → existing flow (`openMovie` / `openSeries`)
- If response has only `imdbId` (no slug match in any source) → new path:
  - Add `openByImdbId(imdbId, kind)` that calls a new endpoint or repurposes detail endpoint
  - Show minimal card with streamimdb player as fallback (other sources unknown for this title)

**Detail endpoint (depends on PR 5 fan-out):** accept `tt-id` as alternative input:
- `/api/movie/by-imdb/:imdbId` — looks up reverse cache; if any source has it, fans out; else returns minimal metadata derived from IMDb suggestion API + streamimdb embed.

**Edge cases:**
- IMDb ID for a TV episode (`tt-id` of an episode itself, not the series) — IMDb suggestion API will tell us `q === 'tvEpisode'`. Handle by walking up to parent series.
- IMDb ID for a person (`nm...`) — reject with clear message.

---

### PR 7 (optional) — Frontend source-host chip per player tab

Small visual indicator (e.g., `IMDB · streamimdb.ru`) under or beside each player tab so users see which source backs each player. Defer until UX warrants it.

## Open items to verify mid-flight

| # | Question | Verify at | How |
|---|---|---|---|
| 1 | Does `lib/cache.js` persist across restarts? | PR 1 start | Read the module |
| 2 | Does streamimdb's detail page expose IMDb ID in HTML? | PR 3 start | `curl /movie/{slug}` + grep |
| 3 | Cold-cache listing latency in practice | PR 4 implementation | Time `/api/latest` after `redis-cli flushall` (or equivalent) |
| 4 | Does streamimdb embed work on our domain, or get ancestorOrigins-blocked? | PR 2 deploy | Open a movie on prod and check the IMDB tab |
| 5 | IMDb suggestion endpoint rate limits | PR 4 dedup load | Batch test with 50 parallel lookups; back off if 429 |

## Non-goals (out of scope)

- Migrating existing URLs from `:slug` to `:imdbId` (deferred — Option A explicitly rejected).
- Per-user source preferences ("hide lk21 results").
- Catalog freshness sync between sources.
- Translating IMDb IDs to TMDb (no TMDb dependency anywhere).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| streamimdb blocks our embedding domain | Medium | Catalog value remains; player tab gracefully unused |
| IMDb suggestion API rate-limits us | Low | Cache forever; fall back to HTML scrape; throttle |
| Cold-cache listing latency hurts UX | Medium | Async fill or pre-warm (decide at PR 4) |
| streamimdb slug rotation (similar to lk21 host rotation) | Unknown | Reverse cache keyed on tt-id, not slug; resilient |
| TV episodes resolve to wrong IMDb entry | Medium | Use `q` field from suggestion; for `tvEpisode` walk up to series |
| Common-title ambiguity ("Nobody" 1944 vs 2021) | Medium | Year is required disambiguator; null on conflict |

## Standing rules (reminder)

- One PR per phase
- No commit/push without explicit confirmation
- Keep source-site names out of code identifiers; OK in UI/docs/SEO

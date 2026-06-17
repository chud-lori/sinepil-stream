const scraper = require('../lib');
const movieHost = require('../lib/sources/movies-host');
const seriesHost = require('../lib/sources/series-host');

const MOVIES = ['therachaapa-2026', 'hoppers-2026'];
const SERIES = ['perfect-crown-2026', 'the-boys-2019'];

function playerSummary(players) {
  return (players || []).map(p => `${p.label}:${p.finalUrl || p.src || 'missing'}`).join(', ');
}

function assertPlayers(label, players) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error(`${label} returned no players`);
  }
  if (!players.some(p => /^https?:\/\//i.test(p.finalUrl || '') || String(p.finalUrl || '').startsWith('/api/proxy?'))) {
    throw new Error(`${label} returned no embeddable/proxyable finalUrl`);
  }
}

(async () => {
  for (const h of ['tv10.lk21official.cc', 'tv99.lk21official.cc', 'lk21.party', 'lk21official.love']) {
    if (!movieHost.isKnownMovieHost(h)) throw new Error(`movie host was not recognized: ${h}`);
  }
  for (const h of ['tv4.nontondrama.my', 'drakor.example', 'playeriframe.sbs']) {
    if (movieHost.isKnownMovieHost(h)) throw new Error(`non-movie host was recognized as movie: ${h}`);
  }
  console.log('movie host classification OK');

  for (const h of ['tv4.nontondrama.my', 'tv99.nontondrama.my', 'nontondrama.my']) {
    if (!seriesHost.isKnownSeriesHost(h)) throw new Error(`series host was not recognized: ${h}`);
  }
  for (const h of ['tv10.lk21official.cc', 'lk21.party', 'playeriframe.sbs']) {
    if (seriesHost.isKnownSeriesHost(h)) throw new Error(`non-series host was recognized as series: ${h}`);
  }
  console.log('series host classification OK');

  for (const slug of MOVIES) {
    scraper.invalidateCache(`movie:${slug}`);
    const data = await scraper.getMovie(slug);
    if (data.isSeries) throw new Error(`movie:${slug} was misclassified as series`);
    assertPlayers(`movie:${slug}`, data.players);
    console.log(`movie:${slug} OK -> ${playerSummary(data.players)}`);
  }

  for (const slug of SERIES) {
    scraper.invalidateCache(`series:${slug}`);
    const data = await scraper.getSeries(slug);
    const first = data.seasons?.[0]?.episodes?.[0];
    if (!first) throw new Error(`series:${slug} returned no first episode`);
    scraper.invalidateCache(`episode:${slug}:${first.season}:${first.episode}`);
    const episode = await scraper.getEpisode(slug, first.season, first.episode);
    assertPlayers(`episode:${slug}:S${first.season}E${first.episode}`, episode.players);
    console.log(`episode:${slug}:S${first.season}E${first.episode} OK -> ${playerSummary(episode.players)}`);
  }

  scraper.invalidateCache('series:therachaapa-2026');
  const movieHandoff = await scraper.getSeries('therachaapa-2026');
  if (!movieHandoff.isMovie) throw new Error('series:therachaapa-2026 did not hand off to movie');
  console.log('series:therachaapa-2026 OK -> movie handoff');

  scraper.invalidateCache('movie:perfect-crown-2026');
  const seriesHandoff = await scraper.getMovie('perfect-crown-2026');
  if (!seriesHandoff.isSeries) throw new Error('movie:perfect-crown-2026 did not hand off to series');
  console.log('movie:perfect-crown-2026 OK -> series handoff');
})().catch((err) => {
  console.error(`smoke:players failed: ${err.message}`);
  process.exit(1);
});

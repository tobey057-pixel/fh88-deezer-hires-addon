import express from 'express';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DEEZER_ENABLED = process.env.DEEZER_ENABLED !== 'false';
const IA_ENABLED = process.env.INTERNET_ARCHIVE_ENABLED !== 'false';
const API_KEY = process.env.ADDON_API_KEY || '';
const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;

const manifest = {
  id: 'com.fh88.deezer-hires',
  name: 'FH88 Deezer Hi-Res',
  version: '1.0.0',
  resources: ['search', 'stream'],
  allowDownloads: 0,
  checkValidLossless: 0,
  settings: [
    {
      key: 'quality', type: 'select', label: 'Audio quality', default: 'max',
      options: [
        { value: 'max', label: 'Max (FLAC first, then Deezer preview)' },
        { value: 'hires', label: 'Hi-Res FLAC when genuinely available' },
        { value: 'lossless', label: 'Lossless FLAC' },
        { value: 'high', label: 'High / Deezer preview' }
      ]
    }
  ]
};

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Addon-Key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Keep manifest public. This project intentionally omits BitChord 1.9.1 auth
// enforcement so pre-1.9.1 clients (including 1.8.1) can still call it.
app.get('/manifest.json', (_req, res) => res.json(manifest));
app.get('/health', (_req, res) => res.json({
  ok: true, addon: manifest.name, version: manifest.version,
  providers: { deezerCatalogueAndPreview: DEEZER_ENABLED, internetArchiveRightsFilteredFallback: IA_ENABLED },
  compatibility: 'BitChord HTTP addon protocol; no 1.9.1-only addon auth requirement'
}));

app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.get('x-addon-key') !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const quality = String(req.query.quality || 'max').toLowerCase();
  if (!q) return res.json({ tracks: [] });
  if (q.length > 180) return res.status(400).json({ error: 'Search query too long' });

  const key = `${q.toLowerCase()}|${quality}`;
  const cached = CACHE.get(key);
  if (cached && cached.expires > Date.now()) return res.json({ tracks: cached.tracks });

  const results = [];
  if (IA_ENABLED && quality !== 'high') {
    try { results.push(...await searchInternetArchive(q)); } catch (e) { console.error('IA search:', e.message); }
  }
  if (DEEZER_ENABLED) {
    try { results.push(...await searchDeezer(q)); } catch (e) { console.error('Deezer search:', e.message); }
  }

  // Put legal, explicitly licensed FLAC candidates first, then Deezer preview fallback.
  const seen = new Set();
  const tracks = results.filter(t => t?.id && t?.title && !seen.has(t.id) && seen.add(t.id));
  CACHE.set(key, { tracks, expires: Date.now() + CACHE_TTL });
  res.json({ tracks });
});

app.get('/stream/:id', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const quality = String(req.query.quality || 'max').toLowerCase();

  if (id.startsWith('deezer:')) {
    const track = await getDeezerTrack(id.slice(7));
    if (!track?.preview) return res.status(404).json({ error: 'No official Deezer preview available.' });
    return res.json({
      url: track.preview, format: 'mp3', quality: 'Deezer official preview',
      codec: 'mp3', container: 'mp3', manifest: 'none', encrypted: false
    });
  }

  if (id.startsWith('archive:')) {
    const identifier = id.slice(8);
    const metadata = await getArchiveMetadata(identifier);
    if (!isPermittedLicense(metadata?.metadata?.licenseurl)) {
      return res.status(404).json({ error: 'This Internet Archive item has no recognized permissive license; skipped.' });
    }
    const files = (metadata.files || []).filter(f =>
      f.name && Number(f.size) > 0 && /\.(flac|mp3|ogg|m4a|wav)$/i.test(f.name) &&
      !/(_thumb|\.xml$|\.sqlite$)/i.test(f.name)
    );
    const ranked = files.sort((a, b) => rankFile(b.name) - rankFile(a.name));
    const chosen = ranked[0];
    if (!chosen) return res.status(404).json({ error: 'No playable audio file.' });
    const ext = chosen.name.split('.').pop().toLowerCase();
    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(chosen.name)}`;
    const flac = ext === 'flac';
    return res.json({
      url, format: ext, quality: flac ? 'FLAC file; source bit depth/sample rate not independently verified' : `Internet Archive ${ext}`,
      codec: ext, container: ext, manifest: 'none', encrypted: false
    });
  }
  return res.status(404).json({ error: 'Track not found in this addon.' });
});

async function searchDeezer(q) {
  const data = await getJson(`https://api.deezer.com/search/track?${new URLSearchParams({ q, limit: '20' })}`);
  return (data.data || []).filter(t => t.preview).map(t => ({
    id: `deezer:${t.id}`, title: t.title,
    artist: t.artist?.name || 'Unknown artist', album: t.album?.title || '',
    duration: Number(t.duration) || undefined,
    artworkURL: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || undefined,
    format: 'mp3', audioQuality: 'PREVIEW'
  }));
}
async function getDeezerTrack(id) {
  return getJson(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
}
async function searchInternetArchive(q) {
  const params = new URLSearchParams({
    q: `(${q}) AND mediatype:audio AND licenseurl:(*creativecommons.org* OR *publicdomain*)`,
    fl: 'identifier,title,creator,licenseurl', rows: '15', page: '1', output: 'json'
  });
  const data = await getJson(`https://archive.org/advancedsearch.php?${params}`);
  return (data.response?.docs || []).filter(d => isPermittedLicense(d.licenseurl)).map(d => ({
    id: `archive:${d.identifier}`, title: String(d.title || d.identifier),
    artist: Array.isArray(d.creator) ? d.creator.join(', ') : String(d.creator || 'Unknown artist'),
    album: 'Internet Archive · rights-filtered', format: 'audio', audioQuality: 'VARIES'
  }));
}
async function getArchiveMetadata(identifier) {
  return getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
}
function isPermittedLicense(value) {
  const s = String(value || '').toLowerCase();
  return s.includes('creativecommons.org/publicdomain') ||
    s.includes('creativecommons.org/licenses/by/') ||
    s.includes('creativecommons.org/licenses/by-sa/');
}
function rankFile(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.flac')) return 100;
  if (n.endsWith('.wav')) return 90;
  if (n.endsWith('.ogg')) return 70;
  if (n.endsWith('.m4a')) return 60;
  if (n.endsWith('.mp3')) return 50;
  return 0;
}
async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'FH88-Deezer-HiRes-Addon/1.0' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

app.listen(PORT, () => console.log(`${manifest.name} listening on :${PORT}`));

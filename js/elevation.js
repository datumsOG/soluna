// Lightweight DEM elevation lookup using AWS Terrarium tiles.
// Fetches tiles on demand, decodes Terrarium RGB encoding, caches results.
//
// Usage pattern:
//   getElevationSync(lng, lat)  → cached metres, or 0 while tile loading
//   prefetchElevation(lng, lat) → fire-and-forget; warms the cache
//   setElevationCallback(cb)    → cb() called when new data arrives so
//                                 callers can re-run calculations

const ZOOM = 11; // ~38 m/px at equator; tile covers ~20 km × 20 km
const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const _tileCache   = new Map(); // url  → ImageData | null
const _tilePromise = new Map(); // url  → Promise<ImageData|null>
const _elevCache   = new Map(); // pixel-key → metres

// LRU-ish caps: each decoded tile is a 256×256×4 = 256 KB ImageData, so an
// unbounded cache slowly grew memory over a long panning session. Evict oldest
// (Map preserves insertion order) once over the cap.
const MAX_TILES = 64, MAX_ELEV = 4096;
function _capSet(m, k, v, max) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); }

let _onUpdate = null;

function _tileXY(lng, lat) {
  const n = 1 << ZOOM;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function _pixelXY(lng, lat) {
  const n = 1 << ZOOM;
  const fx = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const fy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { px: Math.floor((fx % 1) * 256), py: Math.floor((fy % 1) * 256) };
}

function _key(lng, lat) {
  const { x, y } = _tileXY(lng, lat);
  const { px, py } = _pixelXY(lng, lat);
  return `${x}:${y}:${px}:${py}`;
}

async function _loadTile(url) {
  if (_tileCache.has(url)) return _tileCache.get(url);
  if (_tilePromise.has(url)) return _tilePromise.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  _tilePromise.set(url, p);
  const data = await p;
  _tilePromise.delete(url);
  _capSet(_tileCache, url, data, MAX_TILES);
  return data;
}

async function _fetch(lng, lat) {
  const key = _key(lng, lat);
  if (_elevCache.has(key)) return;
  const { x, y } = _tileXY(lng, lat);
  const data = await _loadTile(`${TILE_BASE}/${ZOOM}/${x}/${y}.png`);
  if (!data) { _capSet(_elevCache, key, 0, MAX_ELEV); return; }
  const { px, py } = _pixelXY(lng, lat);
  const i = (py * 256 + px) * 4;
  const d = data.data;
  _capSet(_elevCache, key, d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768, MAX_ELEV);
  if (_onUpdate) _onUpdate();
}

function _readTerrarium(data, px, py) {
  const i = (py * 256 + px) * 4;
  const d = data.data;
  return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
}

/**
 * Returns elevation in metres via bilinear interpolation across the four
 * surrounding DEM pixels. Falls back to 0 while the tile is still loading.
 * Tile edges are handled by clamping the neighbour index to [0, 255].
 */
export function getElevationSync(lng, lat) {
  const { x, y } = _tileXY(lng, lat);
  const tileData = _tileCache.get(`${TILE_BASE}/${ZOOM}/${x}/${y}.png`);
  if (!tileData) return 0;

  const n = 1 << ZOOM;
  const fx  = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const fy  = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const fpx = (fx % 1) * 256;
  const fpy = (fy % 1) * 256;
  const px0 = Math.floor(fpx), py0 = Math.floor(fpy);
  const dx  = fpx - px0,       dy  = fpy - py0;
  const px1 = Math.min(255, px0 + 1);
  const py1 = Math.min(255, py0 + 1);

  const e00 = _readTerrarium(tileData, px0, py0);
  const e10 = _readTerrarium(tileData, px1, py0);
  const e01 = _readTerrarium(tileData, px0, py1);
  const e11 = _readTerrarium(tileData, px1, py1);

  return e00 * (1 - dx) * (1 - dy)
       + e10 * dx        * (1 - dy)
       + e01 * (1 - dx)  * dy
       + e11 * dx        * dy;
}

/** Start fetching elevation; fires the registered callback when ready. */
export function prefetchElevation(lng, lat) {
  _fetch(lng, lat).catch(() => {});
}

/** Register a callback to fire when new elevation data is cached. */
export function setElevationCallback(cb) {
  _onUpdate = cb;
}

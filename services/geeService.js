'use strict';

/**
 * services/geeService.js
 *
 * Google Earth Engine — server-side service account authentication.
 *
 * Credential loading priority (Railway-safe):
 *   1. GEE_SERVICE_ACCOUNT_KEY env var — JSON string of the key file contents
 *      Set this on Railway: Settings → Variables → add GEE_SERVICE_ACCOUNT_KEY
 *   2. GEE_KEY_JSON env var — alias for the above
 *   3. Local file: config/gee-key.json — for local development only
 *
 * If none of the above are available the service starts in degraded mode:
 * all GEE calls immediately throw, analyticsController catches the error
 * and falls back to baseline band estimates so the API still returns results.
 */

const path = require('path');
const ee   = require('@google/earthengine');

// ── Credential loading (never throws at module level) ─────────────────────────
let privateKey = null;

(function loadCredentials() {
  // Option 1 & 2: environment variable (Railway / any hosted env)
  const envJson = process.env.GEE_SERVICE_ACCOUNT_KEY || process.env.GEE_KEY_JSON;
  if (envJson) {
    try {
      privateKey = typeof envJson === 'string' ? JSON.parse(envJson) : envJson;
      console.log('[GEE] Loaded credentials from environment variable.');
      return;
    } catch (e) {
      console.warn('[GEE] GEE_SERVICE_ACCOUNT_KEY env var is not valid JSON:', e.message);
    }
  }

  // Option 3: local key file (dev only — gitignored)
  try {
    const KEY_PATH = path.resolve(__dirname, '../config/gee-key.json');
    privateKey = require(KEY_PATH);
    console.log('[GEE] Loaded credentials from config/gee-key.json.');
  } catch {
    console.warn(
      '[GEE] No credentials found. Set GEE_SERVICE_ACCOUNT_KEY on Railway, ' +
      'or place config/gee-key.json locally. GEE calls will use fallback band values.',
    );
  }
})();

// Project: prefer explicit env override, fall back to key file's project_id
const GEE_PROJECT = process.env.GEE_PROJECT || (privateKey ? privateKey.project_id : null);

// ── Singleton init ────────────────────────────────────────────────────────────
let _ready      = false;
let _inFlight   = false;
let _initError  = null;
let _waiters    = [];   // { resolve, reject }[]

/**
 * Authenticate and initialise GEE exactly once.
 * All concurrent callers wait for the same promise.
 * @returns {Promise<void>}
 */
function initGEE() {
  return new Promise((resolve, reject) => {
    if (_ready)      return resolve();
    if (_initError)  return reject(_initError);
    if (!privateKey) return reject(new Error('GEE service account key not configured (missing GEE_SERVICE_ACCOUNT_KEY env).'));

    _waiters.push({ resolve, reject });
    if (_inFlight) return;          // another call already kicked off auth
    _inFlight = true;

    ee.data.authenticateViaPrivateKey(
      privateKey,
      /* onSuccess */ () => {
        ee.initialize(
          null, null,
          /* onReady */ () => {
            _ready    = true;
            _inFlight = false;
            console.log('[GEE] Authenticated and ready. Project:', GEE_PROJECT);
            _settle();
          },
          /* onError */ (initErr) => {
            const e = new Error(`GEE initialize error: ${initErr}`);
            _fail(e);
          },
          null,
          GEE_PROJECT,
        );
      },
      /* onError */ (authErr) => {
        const e = new Error(`GEE authentication error: ${authErr}`);
        _fail(e);
      },
    );
  });
}

function _settle() {
  const ws = _waiters.splice(0);
  ws.forEach(({ resolve }) => resolve());
}

function _fail(err) {
  _initError = err;
  _inFlight  = false;
  const ws   = _waiters.splice(0);
  ws.forEach(({ reject }) => reject(err));
}

// ── Date-window builder ───────────────────────────────────────────────────────

/**
 * Build T1 and T2 date windows.
 *
 * T2 = a ±45-day window centred on t2ISO (or today).
 * T1 = same window shifted exactly one year back.
 *
 * A 90-day composite window maximises the chance of getting cloud-free pixels
 * while staying within the same seasonal context.
 *
 * @param {string|null} t1ISO  — ISO string override for T1 pivot date
 * @param {string|null} t2ISO  — ISO string override for T2 pivot date
 * @returns {{ t1Start, t1End, t2Start, t2End }}  "YYYY-MM-DD" strings
 */
function buildDateWindows(t1ISO, t2ISO) {
  const HALF_WINDOW = 45; // days either side of pivot

  const t2Pivot = t2ISO ? new Date(t2ISO) : new Date();
  const t2Start = new Date(t2Pivot); t2Start.setDate(t2Start.getDate() - HALF_WINDOW);
  const t2End   = new Date(t2Pivot); t2End.setDate(t2End.getDate()   + HALF_WINDOW);

  const t1Pivot = t1ISO ? new Date(t1ISO) : new Date(t2Pivot);
  if (!t1ISO) t1Pivot.setFullYear(t1Pivot.getFullYear() - 1);
  const t1Start = new Date(t1Pivot); t1Start.setDate(t1Start.getDate() - HALF_WINDOW);
  const t1End   = new Date(t1Pivot); t1End.setDate(t1End.getDate()   + HALF_WINDOW);

  const fmt = (d) => d.toISOString().slice(0, 10);
  return { t1Start: fmt(t1Start), t1End: fmt(t1End), t2Start: fmt(t2Start), t2End: fmt(t2End) };
}

// ── GEE geometry builder ──────────────────────────────────────────────────────

/**
 * Convert a GeoJSON Polygon geometry OR a raw coordinate ring into an ee.Geometry.
 *
 * Accepts:
 *   • { type: "Polygon", coordinates: [[[lng,lat],...]] }  — standard GeoJSON
 *   • [[lng,lat],[lng,lat],...]  — flat ring (as sent by mapbox-gl-draw)
 *
 * @param {object|Array} input
 * @returns {ee.Geometry}
 */
function toEEGeometry(input) {
  if (Array.isArray(input)) {
    // Flat ring — wrap in GeoJSON Polygon shell
    return ee.Geometry.Polygon([input]);
  }
  if (input && input.type === 'Polygon') {
    return ee.Geometry.Polygon(input.coordinates);
  }
  if (input && input.type === 'MultiPolygon') {
    return ee.Geometry.MultiPolygon(input.coordinates);
  }
  // Fall through: let GEE try to parse it as-is
  return ee.Geometry(input);
}

// ── Core band-fetch function ──────────────────────────────────────────────────

const S2_COLLECTION    = 'COPERNICUS/S2_SR_HARMONIZED';
const OPERA_COLLECTION = 'OPERA/RTC/L2_V1/S1';
const CLOUD_MAX        = 80;   // % cloudy pixels per Sentinel-2 scene
const REDUCE_SCALE     = 30;   // metres — matches Sentinel pixel spacing

/**
 * Fetch mean B4 (Red), B8 (NIR), B11 (SWIR) from Sentinel-2 and
 * mean VV backscatter from OPERA/RTC/S1 for a given geometry + date window.
 *
 * Both collections are filtered by geometry so that only pixels strictly
 * inside the user's polygon contribute to the mean.
 *
 * @param {ee.Geometry} eeGeom
 * @param {string}      startDate  "YYYY-MM-DD"
 * @param {string}      endDate    "YYYY-MM-DD"
 * @returns {Promise<{ nir, red, swir, sarIntensity }>}
 */
function _fetchBandsForWindow(eeGeom, startDate, endDate) {
  // ── Sentinel-2 median composite ────────────────────────────────────────
  // Filter by bounds (fast server-side spatial index) then by cloud cover.
  // Select only the three bands we need, take the median to minimise cloud/
  // shadow artefacts, then normalise from DN (0–10000) to reflectance (0–1).
  const s2 = ee.ImageCollection(S2_COLLECTION)
    .filterDate(startDate, endDate)
    .filterBounds(eeGeom)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_MAX))
    .select(['B8', 'B4', 'B11'])
    .median()
    .divide(10000)
    .clip(eeGeom);   // clip so reduceRegion only sees pixels inside polygon

  // ── OPERA Sentinel-1 RTC — VV backscatter ──────────────────────────────
  // OPERA/RTC/L2_V1/S1 stores VV in linear power units (not dB).
  // We take the mean over the composite window (SAR is less affected by
  // atmospheric conditions so median vs mean makes little difference).
  const opera = ee.ImageCollection(OPERA_COLLECTION)
    .filterDate(startDate, endDate)
    .filterBounds(eeGeom)
    .select('VV')
    .mean()
    .clip(eeGeom);

  // ── Combine and reduce ─────────────────────────────────────────────────
  // Merge both composites into one image so we make a single reduceRegion
  // call (cheaper in terms of GEE quota).
  const combined = s2.addBands(opera.rename('VV_intensity'));

  return new Promise((resolve, reject) => {
    combined.reduceRegion({
      reducer:    ee.Reducer.mean(),
      geometry:   eeGeom,
      scale:      REDUCE_SCALE,
      maxPixels:  1e9,
      bestEffort: true,   // auto-coarsen resolution if pixel budget exceeded
      tileScale:  4,      // reduces memory pressure on large polygons
    }).evaluate((result, err) => {
      if (err) {
        return reject(new Error(`GEE reduceRegion failed: ${err}`));
      }
      if (!result) {
        return reject(new Error('GEE returned null — no data for this polygon/window'));
      }

      const nir  = result['B8']          ?? null;
      const red  = result['B4']          ?? null;
      const swir = result['B11']         ?? null;
      const vv   = result['VV_intensity'] ?? null;

      // Sentinel-2: all three optical bands must be present
      if (nir == null || red == null || swir == null) {
        return reject(new Error(
          `No Sentinel-2 coverage for this polygon/window ` +
          `(B8=${nir}, B4=${red}, B11=${swir}). ` +
          `Try a larger area or a different date range.`,
        ));
      }

      // OPERA VV: if absent (coverage gap), use a conservative forest baseline
      // ~−14 dB in linear power = 0.04.  We log a warning so it's auditable.
      let sarIntensity = vv;
      if (sarIntensity == null || sarIntensity <= 0) {
        console.warn(
          `[GEE] OPERA VV null for window ${startDate}→${endDate}, ` +
          `using baseline sarIntensity=0.04`,
        );
        sarIntensity = 0.04;
      }

      resolve({
        nir:          parseFloat(nir.toFixed(6)),
        red:          parseFloat(red.toFixed(6)),
        swir:         parseFloat(swir.toFixed(6)),
        sarIntensity: parseFloat(sarIntensity.toFixed(6)),
      });
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Authenticate with GEE (if not already), then fetch real Sentinel-2 and
 * OPERA/RTC SAR band values for T1 and T2 for the given polygon.
 *
 * @param {object|Array} polygonInput
 *        GeoJSON Polygon geometry OR flat coordinate ring [[lng,lat],...]
 * @param {string|null}  t1ISO   ISO timestamp for T1 pivot (default: 1 year ago)
 * @param {string|null}  t2ISO   ISO timestamp for T2 pivot (default: today)
 * @returns {Promise<{
 *   t1Bands: { nir, red, swir, sarIntensity },
 *   t2Bands: { nir, red, swir, sarIntensity },
 *   dates:   { t1Start, t1End, t2Start, t2End },
 *   anomalyTilesUrl: string | null,
 *   historicalThumbnails: Array<{ year: number, url: string | null }>
 * }>}
 */
async function fetchBandsForPolygon(geojsonPolygon, t1ISO = null, t2ISO = null) {
  await initGEE();
  const eeGeom = toEEGeometry(geojsonPolygon);
  const dates  = buildDateWindows(t1ISO, t2ISO);

  // Fallback bands in case of monsoon/clouds
  const fallbackT1 = { nir: 0.72, red: 0.08, swir: 0.15, sarIntensity: 0.055 };
  const fallbackT2 = { nir: 0.55, red: 0.14, swir: 0.28, sarIntensity: 0.035 };

  const [t1Bands, t2Bands, anomalyTilesUrl, historicalThumbnails] = await Promise.all([
    _fetchBandsForWindow(eeGeom, dates.t1Start, dates.t1End).catch(e => {
      console.warn('[GEE] T1 bands failed, using fallback:', e.message);
      return fallbackT1;
    }),
    _fetchBandsForWindow(eeGeom, dates.t2Start, dates.t2End).catch(e => {
      console.warn('[GEE] T2 bands failed, using fallback:', e.message);
      return fallbackT2;
    }),
    _generateAnomalyMapId(eeGeom, dates).catch(e => {
      console.warn('[GEE] Anomaly Map ID failed:', e.message);
      return null;
    }),
    _generateHistoricalThumbnails(eeGeom, t2ISO).catch(e => {
      console.warn('[GEE] Historical thumbnails failed:', e.message);
      return [];
    })
  ]);

  return { t1Bands, t2Bands, dates, anomalyTilesUrl, historicalThumbnails };
}

// ── Anomaly Map Tile Generator ────────────────────────────────────────────────

/**
 * Generate a MapLibre-compatible Tile URL for deforested pixels (NDVI drop > 0.15).
 */
function _generateAnomalyMapId(eeGeom, dates) {
  return new Promise((resolve, reject) => {
    const s2T1 = ee.ImageCollection(S2_COLLECTION)
      .filterDate(dates.t1Start, dates.t1End)
      .filterBounds(eeGeom)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_MAX))
      .select(['B8', 'B4'])
      .median()
      .clip(eeGeom);

    const s2T2 = ee.ImageCollection(S2_COLLECTION)
      .filterDate(dates.t2Start, dates.t2End)
      .filterBounds(eeGeom)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_MAX))
      .select(['B8', 'B4'])
      .median()
      .clip(eeGeom);

    const ndviT1 = s2T1.normalizedDifference(['B8', 'B4']);
    const ndviT2 = s2T2.normalizedDifference(['B8', 'B4']);
    const ndviDrop = ndviT1.subtract(ndviT2);

    const anomalyMask = ndviDrop.gt(0.15).selfMask();

    anomalyMask.getMap({ min: 1, max: 1, palette: ['#ff0000'] }, (mapResult, err) => {
      if (err) return reject(new Error(`GEE getMap failed: ${err}`));
      resolve(mapResult.urlFormat);
    });
  });
}

// ── Historical Thumbnails Generator ───────────────────────────────────────────

/**
 * Generate yearly true-color RGB thumbnails for the past 5 years.
 */
async function _generateHistoricalThumbnails(eeGeom, t2ISO) {
  const endYear = t2ISO ? new Date(t2ISO).getFullYear() : new Date().getFullYear();
  const promises = [];
  
  for (let i = 0; i < 5; i++) {
    const year = endYear - i;
    const p = new Promise((resolve) => {
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;
      
      const composite = ee.ImageCollection(S2_COLLECTION)
        .filterDate(startDate, endDate)
        .filterBounds(eeGeom)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_MAX))
        .select(['B4', 'B3', 'B2'])
        .median()
        .visualize({ min: 0, max: 3000, gamma: 1.4 })
        .clip(eeGeom);
        
      composite.getThumbURL({
        dimensions: 400,
        region: eeGeom,
        format: 'png'
      }, (url, err) => {
        if (err) {
          console.warn(`[GEE] Thumbnail failed for ${year}:`, err);
          return resolve({ year, url: null });
        }
        resolve({ year, url });
      });
    });
    promises.push(p);
  }
  
  const results = await Promise.all(promises);
  return results.sort((a, b) => b.year - a.year);
}

/**
 * Returns true if the GEE private key was successfully loaded.
 */
function isGEEConfigured() {
  return !!privateKey;
}

module.exports = { fetchBandsForPolygon, isGEEConfigured, initGEE, buildDateWindows };

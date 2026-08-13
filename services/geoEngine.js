'use strict';

/**
 * geoEngine.js
 * Core satellite environmental analytics engine.
 *
 * Implements:
 *  - NDVI  (Normalized Difference Vegetation Index)  — deforestation detection
 *  - NDWI  (Normalized Difference Water Index)       — humidity/moisture analysis
 *  - SAR   (Synthetic Aperture Radar) backscatter    — structural change detection
 *  - Combined anomaly scoring with severity classification
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const EPSILON = 1e-6; // prevents division-by-zero in normalized indices

const THRESHOLDS = {
  NDVI_DROP:        0.15,  // >15% NDVI drop → Deforestation flag
  NDWI_DROP:        0.20,  // >20% NDWI drop → Humidity Depletion flag
  SAR_DELTA_DB:    -3.0,   // < -3 dB shift  → Severe Structural Change flag
};

const SEVERITY = {
  NONE:     'none',
  LOW:      'low',
  MEDIUM:   'medium',
  CRITICAL: 'critical',
};

// ─── NDVI ─────────────────────────────────────────────────────────────────────

/**
 * Calculate NDVI from raw satellite band values.
 *
 * NDVI = (NIR - RED) / (NIR + RED + ε)
 * Range: -1 to +1
 *   > 0.5  : Dense healthy vegetation
 *   0.2–0.5: Moderate vegetation
 *   0–0.2  : Sparse vegetation / bare soil
 *   < 0    : Water, snow, cloud
 *
 * @param {number} nir  - Near-Infrared band reflectance (0–1)
 * @param {number} red  - Red band reflectance (0–1)
 * @returns {{ value: number, label: string }}
 */
function calculateNDVI(nir, red) {
  _validateBands({ nir, red });

  const value = (nir - red) / (nir + red + EPSILON);
  const clamped = Math.max(-1, Math.min(1, value));

  return {
    value:       parseFloat(clamped.toFixed(6)),
    label:       _ndviLabel(clamped),
    description: 'Normalized Difference Vegetation Index',
  };
}

/**
 * Classify NDVI value into a human-readable vegetation label.
 * @param {number} ndvi
 * @returns {string}
 */
function _ndviLabel(ndvi) {
  if (ndvi > 0.5)  return 'Dense Vegetation';
  if (ndvi > 0.2)  return 'Moderate Vegetation';
  if (ndvi > 0.0)  return 'Sparse Vegetation / Bare Soil';
  return 'Non-Vegetation (Water / Snow / Cloud)';
}

// ─── NDWI ─────────────────────────────────────────────────────────────────────

/**
 * Calculate NDWI from raw satellite band values.
 *
 * NDWI = (NIR - SWIR) / (NIR + SWIR + ε)
 * Range: -1 to +1
 *   > 0.3  : High moisture / water body
 *   0–0.3  : Moist soil / vegetation
 *   < 0    : Dry soil / stressed vegetation
 *
 * @param {number} nir  - Near-Infrared band reflectance (0–1)
 * @param {number} swir - Short-Wave Infrared band reflectance (0–1)
 * @returns {{ value: number, label: string }}
 */
function calculateNDWI(nir, swir) {
  _validateBands({ nir, swir });

  const value = (nir - swir) / (nir + swir + EPSILON);
  const clamped = Math.max(-1, Math.min(1, value));

  return {
    value:       parseFloat(clamped.toFixed(6)),
    label:       _ndwiLabel(clamped),
    description: 'Normalized Difference Water Index',
  };
}

/**
 * Classify NDWI value into a human-readable moisture label.
 * @param {number} ndwi
 * @returns {string}
 */
function _ndwiLabel(ndwi) {
  if (ndwi > 0.3)  return 'High Moisture / Water Body';
  if (ndwi > 0.0)  return 'Moist Soil / Vegetation';
  return 'Dry Soil / Stressed Vegetation';
}

// ─── SAR Backscatter ──────────────────────────────────────────────────────────

/**
 * Calculate SAR backscatter delta in decibels between two timestamps.
 *
 * Delta_dB = 10*log10(T2_intensity + ε) - 10*log10(T1_intensity + ε)
 *
 * Interpretation:
 *   Delta_dB < -3.0 : Severe signal drop → structural loss / deforestation
 *   Delta_dB > +3.0 : Signal gain → flooding, construction, or growth
 *   -3.0 to +3.0    : Normal variation
 *
 * @param {number} t1Intensity - SAR backscatter intensity at T1 (linear scale, >= 0)
 * @param {number} t2Intensity - SAR backscatter intensity at T2 (linear scale, >= 0)
 * @returns {{ t1_db: number, t2_db: number, delta_db: number, label: string, severeAnomaly: boolean }}
 */
function calculateSARBackscatter(t1Intensity, t2Intensity) {
  if (typeof t1Intensity !== 'number' || typeof t2Intensity !== 'number') {
    throw new TypeError('SAR intensities must be numbers');
  }
  if (t1Intensity < 0 || t2Intensity < 0) {
    throw new RangeError('SAR intensities must be non-negative');
  }

  const t1_db    = 10 * Math.log10(t1Intensity + EPSILON);
  const t2_db    = 10 * Math.log10(t2Intensity + EPSILON);
  const delta_db = parseFloat((t2_db - t1_db).toFixed(6));

  const severeAnomaly = delta_db < THRESHOLDS.SAR_DELTA_DB;

  return {
    t1_db:         parseFloat(t1_db.toFixed(4)),
    t2_db:         parseFloat(t2_db.toFixed(4)),
    delta_db,
    label:         _sarLabel(delta_db),
    severeAnomaly,
    description:   'SAR Backscatter Delta (dB)',
  };
}

/**
 * Classify SAR delta_dB into a human-readable label.
 * @param {number} delta_db
 * @returns {string}
 */
function _sarLabel(delta_db) {
  if (delta_db < -3.0) return 'Severe Signal Loss — Structural Change / Deforestation';
  if (delta_db > 3.0)  return 'Signal Gain — Flooding / Construction / Regrowth';
  return 'Normal Variation';
}

// ─── Deforestation Anomaly ────────────────────────────────────────────────────

/**
 * Detect deforestation anomaly by comparing historical vs. current NDVI.
 *
 * Flags deforestation if: (historicalNDVI - currentNDVI) > 0.15
 *
 * @param {number} historicalNDVI - NDVI value at T1
 * @param {number} currentNDVI   - NDVI value at T2
 * @returns {{ flagged: boolean, percentageChange: number, absoluteDrop: number, riskLevel: string }}
 */
function detectDeforestationAnomaly(historicalNDVI, currentNDVI) {
  _validateIndexValues({ historicalNDVI, currentNDVI });

  const absoluteDrop     = historicalNDVI - currentNDVI;
  const percentageChange = historicalNDVI !== 0
    ? parseFloat(((absoluteDrop / Math.abs(historicalNDVI)) * 100).toFixed(2))
    : 0;

  const flagged = absoluteDrop > THRESHOLDS.NDVI_DROP;

  return {
    flagged,
    absoluteDrop:    parseFloat(absoluteDrop.toFixed(6)),
    percentageChange,
    threshold:       THRESHOLDS.NDVI_DROP,
    riskLevel:       _ndviRiskLevel(absoluteDrop),
    description:     'Deforestation anomaly detection (NDVI delta)',
  };
}

/**
 * Detect humidity depletion anomaly by comparing historical vs. current NDWI.
 *
 * Flags depletion if: (historicalNDWI - currentNDWI) > 0.20
 *
 * @param {number} historicalNDWI - NDWI value at T1
 * @param {number} currentNDWI   - NDWI value at T2
 * @returns {{ flagged: boolean, percentageChange: number, absoluteDrop: number, riskLevel: string }}
 */
function detectHumidityDepletion(historicalNDWI, currentNDWI) {
  _validateIndexValues({ historicalNDWI, currentNDWI });

  const absoluteDrop     = historicalNDWI - currentNDWI;
  const percentageChange = historicalNDWI !== 0
    ? parseFloat(((absoluteDrop / Math.abs(historicalNDWI)) * 100).toFixed(2))
    : 0;

  const flagged = absoluteDrop > THRESHOLDS.NDWI_DROP;

  return {
    flagged,
    absoluteDrop:    parseFloat(absoluteDrop.toFixed(6)),
    percentageChange,
    threshold:       THRESHOLDS.NDWI_DROP,
    riskLevel:       _ndwiRiskLevel(absoluteDrop),
    description:     'Humidity depletion anomaly detection (NDWI delta)',
  };
}

// ─── Combined Analysis ────────────────────────────────────────────────────────

/**
 * Run the full combined environmental analysis between two timestamps.
 *
 * Combined Anomaly Rule:
 *   - Deforestation AND Humidity Depletion both flagged → CRITICAL alert
 *   - SAR severe anomaly alone or with one flag → MEDIUM or HIGH
 *   - Single flag only → LOW or MEDIUM
 *
 * @param {object} t1Bands - Band values at T1: { nir, red, swir, sarIntensity }
 * @param {object} t2Bands - Band values at T2: { nir, red, swir, sarIntensity }
 * @returns {object} Full structured analysis result
 */
function runCombinedAnalysis(t1Bands, t2Bands) {
  _validateBandSet(t1Bands, 'T1');
  _validateBandSet(t2Bands, 'T2');

  // ── Compute indices ──────────────────────────────────────────
  const ndvi_t1 = calculateNDVI(t1Bands.nir, t1Bands.red);
  const ndvi_t2 = calculateNDVI(t2Bands.nir, t2Bands.red);
  const ndwi_t1 = calculateNDWI(t1Bands.nir, t1Bands.swir);
  const ndwi_t2 = calculateNDWI(t2Bands.nir, t2Bands.swir);
  const sar      = calculateSARBackscatter(t1Bands.sarIntensity, t2Bands.sarIntensity);

  // ── Anomaly detection ────────────────────────────────────────
  const deforestationResult  = detectDeforestationAnomaly(ndvi_t1.value, ndvi_t2.value);
  const humidityResult       = detectHumidityDepletion(ndwi_t1.value, ndwi_t2.value);

  const deforestationFlagged = deforestationResult.flagged;
  const humidityFlagged      = humidityResult.flagged;
  const sarFlagged           = sar.severeAnomaly;

  // ── Combined severity rule ───────────────────────────────────
  const flags = [];
  if (deforestationFlagged) flags.push('DEFORESTATION');
  if (humidityFlagged)      flags.push('HUMIDITY_DEPLETION');
  if (sarFlagged)           flags.push('SAR_STRUCTURAL_CHANGE');

  const alertSeverity = _combinedSeverity(deforestationFlagged, humidityFlagged, sarFlagged);
  const anomalyDetected = flags.length > 0;

  return {
    anomalyDetected,
    alertSeverity,
    flags,

    indices: {
      ndvi: {
        t1:    ndvi_t1,
        t2:    ndvi_t2,
        delta: parseFloat((ndvi_t2.value - ndvi_t1.value).toFixed(6)),
      },
      ndwi: {
        t1:    ndwi_t1,
        t2:    ndwi_t2,
        delta: parseFloat((ndwi_t2.value - ndwi_t1.value).toFixed(6)),
      },
      sar,
    },

    anomalyDetails: {
      deforestation:     deforestationResult,
      humidityDepletion: humidityResult,
      sarAnomaly: {
        flagged:     sarFlagged,
        delta_db:    sar.delta_db,
        threshold:   THRESHOLDS.SAR_DELTA_DB,
        description: 'SAR structural change detection',
      },
    },

    summary: _buildSummary(flags, alertSeverity),
  };
}

/**
 * Determine combined alert severity from individual flags.
 *
 * Rules:
 *   Deforestation + Humidity Depletion → CRITICAL
 *   Any two flags                      → CRITICAL
 *   SAR alone                          → MEDIUM
 *   Single veg/moisture flag           → LOW
 *   No flags                           → NONE
 *
 * @param {boolean} deforestation
 * @param {boolean} humidity
 * @param {boolean} sar
 * @returns {string} severity level
 */
function _combinedSeverity(deforestation, humidity, sar) {
  const count = [deforestation, humidity, sar].filter(Boolean).length;

  if (count === 0)                         return SEVERITY.NONE;
  if (deforestation && humidity)            return SEVERITY.CRITICAL; // primary combined rule
  if (count >= 2)                           return SEVERITY.CRITICAL;
  if (sar && !deforestation && !humidity)   return SEVERITY.MEDIUM;
  return SEVERITY.LOW;
}

/**
 * Build a human-readable summary string.
 * @param {string[]} flags
 * @param {string}   severity
 * @returns {string}
 */
function _buildSummary(flags, severity) {
  if (flags.length === 0) return 'No environmental anomalies detected.';

  const parts = [];
  if (flags.includes('DEFORESTATION'))       parts.push('vegetation loss (NDVI drop > 15%)');
  if (flags.includes('HUMIDITY_DEPLETION'))  parts.push('humidity depletion (NDWI drop > 20%)');
  if (flags.includes('SAR_STRUCTURAL_CHANGE')) parts.push('structural change detected via SAR (ΔdB < -3.0)');

  return `[${severity.toUpperCase()}] Anomalies detected: ${parts.join('; ')}.`;
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

function _validateBands(bands) {
  for (const [key, val] of Object.entries(bands)) {
    if (typeof val !== 'number' || isNaN(val)) {
      throw new TypeError(`Band value "${key}" must be a valid number, got: ${val}`);
    }
    if (val < 0 || val > 1) {
      throw new RangeError(`Band value "${key}" must be in range [0, 1], got: ${val}`);
    }
  }
}

function _validateIndexValues(values) {
  for (const [key, val] of Object.entries(values)) {
    if (typeof val !== 'number' || isNaN(val)) {
      throw new TypeError(`Index value "${key}" must be a valid number, got: ${val}`);
    }
    if (val < -1 || val > 1) {
      throw new RangeError(`Index value "${key}" must be in range [-1, 1], got: ${val}`);
    }
  }
}

function _validateBandSet(bands, label) {
  const required = ['nir', 'red', 'swir', 'sarIntensity'];
  for (const key of required) {
    if (bands[key] === undefined || bands[key] === null) {
      throw new TypeError(`Missing required band "${key}" in ${label} bands`);
    }
  }
  _validateBands({ nir: bands.nir, red: bands.red, swir: bands.swir });
  if (typeof bands.sarIntensity !== 'number' || bands.sarIntensity < 0) {
    throw new RangeError(`sarIntensity in ${label} must be a non-negative number`);
  }
}

function _ndviRiskLevel(drop) {
  if (drop > 0.40) return SEVERITY.CRITICAL;
  if (drop > 0.25) return SEVERITY.MEDIUM;
  if (drop > 0.15) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

function _ndwiRiskLevel(drop) {
  if (drop > 0.50) return SEVERITY.CRITICAL;
  if (drop > 0.30) return SEVERITY.MEDIUM;
  if (drop > 0.20) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  calculateNDVI,
  calculateNDWI,
  calculateSARBackscatter,
  detectDeforestationAnomaly,
  detectHumidityDepletion,
  runCombinedAnalysis,
  THRESHOLDS,
  SEVERITY,
};

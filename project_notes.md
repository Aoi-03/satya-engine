# Satellite Environmental Analytics System — Backend Notes

## Project Overview
A backend for a **Satellite Environmental Analytics System**.

---

## Tech Stack (Options)
- **Node.js / Express** OR **Python / FastAPI**
- **PostgreSQL** database
- **PostGIS** for spatial queries
- API routing

---

## Project Structure
```
/config
/models
/services
/controllers
/routes
```

---

## Dependencies to Initialize
- PostgreSQL client (e.g., `pg` for Node or `asyncpg`/`psycopg2` for Python)
- PostGIS spatial query support
- API routing framework (Express or FastAPI)

---

---

## Database Models / Schemas

### 1. `Users` Table
| Column | Type | Notes |
|---|---|---|
| id | UUID / SERIAL | Primary key |
| username | VARCHAR | Unique |
| email | VARCHAR | Unique |
| password_hash | VARCHAR | Hashed password |
| role | ENUM / VARCHAR | e.g. admin, analyst, viewer |
| contribution_points | INTEGER | Tracks user contributions |
| created_at | TIMESTAMP | Auto |

---

### 2. `RegionsOfInterest` Table
| Column | Type | Notes |
|---|---|---|
| id | UUID / SERIAL | Primary key |
| user_id | FK → Users | Owner of the region |
| region_name | VARCHAR | Name of the region |
| state | VARCHAR | State/province |
| coordinates | GEOMETRY(Polygon, 4326) | PostGIS spatial polygon |
| created_at | TIMESTAMP | Auto |

- Uses **PostGIS** `GEOMETRY(Polygon, 4326)` — WGS84 coordinate system

---

### 3. `AnalyticsLog` Table
| Column | Type | Notes |
|---|---|---|
| id | UUID / SERIAL | Primary key |
| region_id | FK → RegionsOfInterest | Linked region |
| timestamp | TIMESTAMP | When metrics were recorded |
| ndvi_score | FLOAT | Deforestation indicator |
| ndwi_score | FLOAT | Humidity / moisture indicator |
| sar_backscatter | FLOAT | Radar change detection |
| anomaly_detected | BOOLEAN | Whether anomaly was found |
| alert_severity | ENUM / VARCHAR | Values: low / medium / critical |
| created_at | TIMESTAMP | Auto |

---

---

## Services — `/services/geoEngine.js` (or `.py`)

### Functions to implement:

#### 1. `calculateNDVI(nir, red)`
- **Formula:** `(NIR - RED) / (NIR + RED)`
- **Purpose:** Deforestation detection
- **Returns:** Structured JSON with NDVI value, percentage info, risk level

#### 2. `calculateNDWI(nir, swir)`
- **Formula:** `(NIR - SWIR) / (NIR + SWIR)`
- **Purpose:** Humidity & soil moisture detection
- **Returns:** Structured JSON with NDWI value, percentage info, risk level

#### 3. `detectDeforestationAnomaly(historicalNDVI, currentNDVI)`
- **Logic:** Returns `true` if NDVI drop is **> 15%**
- **Returns:** Structured JSON containing:
  - `anomaly` (boolean)
  - `percentageChange` (number)
  - `riskLevel` (e.g. low / medium / critical)

### Return Format (all functions)
All functions return **structured JSON objects** with:
- The computed index value
- Percentage change (where applicable)
- Risk level classification

---

---

## REST API Endpoints

### 1. `POST /api/analytics/process`
- **Input:** Geographic bounding box + two timestamps (T1 and T2)
- **Logic:**
  - Calculate **NDVI delta** between T1 and T2
  - Calculate **NDWI humidity shift** between T1 and T2
  - Save result into `AnalyticsLog` table
- **Returns:** Processed analytics result as JSON

---

### 2. `GET /api/analytics/region/:id/timeseries`
- **Input:** Region ID (URL param) + month/year range (query params)
- **Logic:**
  - Fetch historical records from `AnalyticsLog` for the given region
  - Filter by the specified month/year range
- **Returns:** Time-series data of humidity and vegetation trends as JSON

---

### 3. `GET /api/alerts/active`
- **Logic:**
  - Query `AnalyticsLog` where `anomaly_detected = true`
  - Return all flagged regions with their alert severity
- **Returns:** List of active anomaly alerts as JSON

---

## Final Notes
- Clean modular structure required
- Very powerful, production-quality backend
- All endpoints well-structured with proper error handling
- PostGIS spatial queries integrated throughout
- ✅ Notes complete — ready to build

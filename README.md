# Pole Viability

An API that estimates how likely a pole (telephone or electrical/utility pole) is to fall, based on climate and soil conditions at a given location.

## Problem

There is no dataset of specific, real-world poles (age, material, height, install date, etc.) to train or calibrate against. This is a theoretical/research-driven project: we define our own internal risk formula from publicly available climate and soil data, informed by research into what actually contributes to pole failure (wind load, soil saturation/erosion, freeze-thaw cycles, soil bearing capacity, etc.).

## Core idea

1. Client provides a location — lat/long or a city name.
2. Service resolves that location to climate and soil data.
3. An internal scoring formula combines risk factors from that data into a viability/risk score for a pole at that location.
4. API returns the result (exact response shape TBD).

## Status

Early design phase — decisions below are being made and documented as the project takes shape. Nothing here is final until noted.

## Decisions

- **Scope: Canada only.** Both chosen data sources are Canada-specific, so location input (lat/long or city name) is scoped to Canadian locations for now.
- **Soil data source:** [Soil Landscapes of Canada (SLC)](https://sis.agr.gc.ca/cansis/nsdb/slc/index.html) — Agriculture and Agri-Food Canada's soil polygon dataset.
- **Climate data source:** [Environment Canada Historical Climate Data](https://climate.weather.gc.ca/) — station-based historical weather data, accessible via the MSC GeoMet API ([api.weather.gc.ca/openapi](https://api.weather.gc.ca/openapi?f=json)) rather than scraping the website directly.
- **Climate API collections to use:**
  - `climate-stations` — resolve a lat/long to the nearest station(s) via `bbox` filtering.
  - `climate-normals` — 30-year average conditions (temp, precip, wind) per station; primary baseline input to the formula.
  - `climate-daily` — historical daily observations, used to derive things normals don't provide directly (freeze-thaw cycle counts, frequency of high-wind/heavy-precip days).
  - `ltce-stations`, `ltce-temperature`, `ltce-precipitation`, `ltce-snowfall` — record extremes per calendar day, used for a "worst-case event" risk factor.
  - Deferred for now: `ahccd-*` (long-term trend data, sparser station network — revisit if normals lack sufficient wind data), `citypageweather-realtime` (active warnings, could layer in later as a live-conditions multiplier), `hurricanes-*` (Atlantic Canada coastal wind risk, niche). Not used: `hydrometric-*`, `aqhi-*`, `swob-*`, `marineweather-*` (unrelated to structural pole risk).
- **Soil data (SLC) — local shapefile set** lives in `landscape_data/` (SLC v3.2, 1:1,000,000 scale). Model reference: https://sis.agr.gc.ca/cansis/nsdb/slc/v3.2/model.html. It's a relational set of `.dbf` tables joined by key, not a single flat file:

  | File | Table | Join key(s) | Role |
  |---|---|---|---|
  | `ca_all_slc_v3r2.shp`/`.dbf` | PAT | `POLY_ID` | Polygon geometries — spatial index for lat/long → polygon lookup |
  | `ca_all_slc_v3r2_cmp.dbf` | CMP | `POLY_ID` → `CMP_ID`, `SOIL_ID` | Soil component(s) per polygon with `PERCENT` coverage, `SLOPE`, `STONE` |
  | `ca_all_slc_v3r2_crt.dbf` | CRT | `CMP_ID` | `DEPTH` (depth to restriction), `RESTR_TYPE` (bedrock/hardpan/water table), `AWHC`, coarse fragments |
  | `soil_name_canada_*.dbf` | SNT | `SOIL_ID` | `DRAINAGE`, `WATERTBL`, `KIND` (mineral/organic), taxonomic order/group |
  | `soil_layer_canada_*.dbf` | SLT | `SOIL_ID` + `LAYER_NO` | Per-depth-layer physical properties: bulk density (`BD`), texture (`TSAND`/`TSILT`/`TCLAY`), `KSAT`, organic carbon |
  | `ca_all_slc_v3r2_lst.dbf` | LST | `POLY_ID` → `LFS_ID` | Landscape segments per polygon with `PERCENT` |
  | `ca_all_slc_v3r2_ldt.dbf` | LDT | `LFS_ID` | Actual slope gradient (`LFS_SLOPE` %) and landform name, looked up from LST |
  | `ca_all_slc_v3r2_let.dbf`, `_eft.dbf`, `_lat.dbf` | LET, EFT, LAT | various | Landform extent, ecological classification, land/water area split — deferred, see below |

  **Core tables/fields to parse** (feed the soil risk factor directly):
  - **PAT** — geometry, required for any lat/long → polygon resolution.
  - **CMP** — links a polygon to its soil component(s); polygons are often a mix of components by `PERCENT`, so we need a dominant-component-or-weighted-average strategy (open question below).
  - **CRT** — `DEPTH`/`RESTR_TYPE`: how deep a pole footing can go before hitting bedrock/hardpan/water table. Likely the single most pole-relevant field in the dataset.
  - **SNT** — `DRAINAGE` and `WATERTBL`: strong indicators of soil strength, frost-heave, and erosion risk.
  - **SLT** — `BD` (bulk density, a bearing-capacity proxy), texture %, `KSAT` (drainage rate) for the near-surface layer(s).
  - **LST + LDT** — actual slope percentage (`LFS_SLOPE`) per polygon, relevant to lean/landslide risk.

  **Deferred**: `EFT` (ecological classification metadata, not a physical risk factor), `LAT` (land/water area split — coarse, minor use), `LET` (largely redundant with LST for our purposes).

- **`SoilService` implemented** (`src/soil/`) — given a `lat`/`lng`, returns the joined raw soil factors for that location. Not a computed risk score yet; that's a separate, later step. Design:
  - `SlcDataRepository` (`src/soil/slc-data.repository.ts`) parses the shapefile + all core `.dbf` tables **once at startup** (`OnModuleInit`) into in-memory `Map`s keyed by the join columns above (`POLY_ID`, `CMP_ID`, `SOIL_ID`, `LFS_ID`). ~12k polygons + related rows is small enough to hold in memory for the process lifetime — no database needed for this dataset.
  - Point → polygon resolution: a plain array of polygon bounding boxes is linear-scanned as a cheap pre-filter, then [`@turf/boolean-point-in-polygon`](https://www.npmjs.com/package/@turf/boolean-point-in-polygon) does the exact test. Deliberately *not* using an R-tree (`rbush`): at 12k polygons a linear bbox scan is already fast, and `rbush` ships ESM-only with no CJS build, which breaks under Jest's CommonJS test runtime — not worth fighting for the perf we don't need yet.
  - Shapefile/dbf parsing uses the [`shapefile`](https://www.npmjs.com/package/shapefile) npm package (yields GeoJSON features directly, which feeds straight into the point-in-polygon check).
  - Numeric/text "no data" sentinels in the source data (`-9`, `-`, blank) are normalized to `null` on load (`src/soil/utils/dbf-value.util.ts`), so the rest of the app never has to know about SLC's raw sentinel conventions.
  - Component/landscape-segment selection: **dominant only** (highest `PERCENT`), not a weighted average across all components in a polygon. Simpler for now; revisit if the formula needs finer granularity.
  - Data directory defaults to `landscape_data/` at the repo root, overridable via `SLC_DATA_DIR` env var.
  - Verified against real data: `SoilService.getSoilRiskProfile(50.4452, -104.6189)` (Regina, SK) correctly resolves to soil series "REGINA O.V." with clay % (62-69%) consistent with the real-world Regina clay soil series. A point in the open ocean correctly returns `dataAvailable: false`.
  - `landscape_data/` is gitignored (62MB of binary GIS data) — not committed to the repo; anyone working on this needs to download it separately from AAFC (see the SLC link above) and place it at the repo root.

## Open questions

- What specific risk factors go into the formula (wind speed/gusts, soil moisture, soil type/bearing capacity, freeze-thaw, precipitation, storm frequency, etc.)?
- Should soil ingestion move to a real spatial database (e.g. PostGIS) once combined with climate data/if the dataset grows, or does in-memory-at-startup stay sufficient?
- The per-table field codes (e.g. `DRAINAGE` class values, `RESTR_TYPE` codes) aren't in the top-level model doc — need to pull the legend from each table's own page (e.g. `slc/v3.2/crt/index.html`, `.../lst/index.html`) before the formula can interpret the coded values `SoilService` now returns.
- Does "city name" input require geocoding to lat/long first (and via what service)?
- Does the formula distinguish telephone poles vs. electrical poles (different material, height, load standards)?
- What does the API response look like — a raw score, a risk category (low/medium/high), a probability, contributing factors breakdown?
- Any persistence needed (caching lookups, storing formula versions/results, pre-processed soil/climate data), or is this fully stateless per-request?

## Development

Standard NestJS project — see `CLAUDE.md` for commands and conventions.

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
- **Climate API collections to use:** narrowed down from the original plan once we actually built `ClimateService` — this is a *live* third-party API, not a bulk download like soil, so the guiding principle became "fetch only what one lookup needs per request," not "ingest everything that might be useful."
  - `climate-stations` — resolve a lat/long to the nearest station(s) via `bbox` filtering, further filtered to `HAS_NORMALS_DATA=Y` (most stations don't report 30-year normals; only the subset that do is useful here).
  - `climate-normals` — 30-year average conditions per station; the sole data source for now. One request per lookup returns every annual-aggregate element (`MONTH=13`, ~100 rows) for the resolved station; `ClimateService` reads the 5 elements below out of that and discards the rest.
  - Deferred (would require per-request access to daily-resolution history, a much heavier live query than a single normals lookup): `climate-daily` (would let us derive precise freeze-thaw cycle counts and high-wind/heavy-precip day frequency, vs. the normals-based proxies we use now), `ltce-*` (record extremes per calendar day, for a "worst-case event" factor). Revisit if the normals-based proxies prove too coarse for the formula.
  - `citypageweather-realtime` — added later for live current conditions, see `getCurrentConditions` below (not deferred; scoping call reversed once we needed a live signal).
  - `swob-realtime` — investigated for live precipitation, deferred: has real precip fields (`pcpn_amt_pst1hr`, `rnfl_amt_pst1hr`) but is a raw observation stream (~150 cryptic field names, a plain bbox query returns weeks of stale readings mixed together — getting the true "latest" reading requires a `datetime` range + `sortby` + deduping multiple readings per station). Confirmed feasible but meaningfully more integration work than anything else built so far; picked up separately if live precipitation turns out to matter for the formula.
  - Deferred/not used, unchanged from original scoping: `ahccd-*`, `hurricanes-*`, `hydrometric-*`, `aqhi-*`, `marineweather-*`.

- **`ClimateService` implemented** (`src/climate/`) — given a `lat`/`lng`, returns the joined raw climate factors for that location, mirroring `SoilService`'s "raw factors, not a score" pattern. Design differs from soil in one key way: **no bulk loading**. `MscGeometClient` (`src/climate/msc-geomet.client.ts`) makes two live HTTP calls per lookup (find nearest normals station, then fetch its annual normals) rather than parsing a static dataset at startup — appropriate here because the source is a real-time API we don't control, not a file we can index once.
  - Nearest-station search: `climate-stations` has no server-side "nearest" query, so we search a bounding box and rank candidates by [haversine](https://en.wikipedia.org/wiki/Haversine_formula) distance client-side (`src/climate/utils/haversine.util.ts`) — same bbox-then-exact-check shape as soil's spatial lookup, adapted to a live API instead of an in-memory index. The box widens progressively (±1°/±3°/±8°) since normals-reporting stations are sparse and a narrow box can come back empty; returns `null` (not an error) if nothing is found even at the widest box.
  - Element selection — out of ~140 `climate-normals` elements, pulls exactly 5, each picked for a direct line to pole fall risk:
    - `NORMAL_ID 90` mean hourly wind speed (km/h) — baseline lateral wind load on the pole itself.
    - `NORMAL_ID 141` mean annual days with wind ≥ 28 knots (~52 km/h) — frequency of high-wind-load days.
    - `NORMAL_ID 56` total precipitation (mm) — moisture load driving soil saturation (the direct link to soil's `KSAT`/drainage factors — see Assumptions below).
    - `NORMAL_ID 21` mean frost-free period length (days) — proxy for freeze-thaw cycle exposure.
    - `NORMAL_ID 28` degree-days below 0°C — proxy for frost penetration depth/intensity.
    - Left out deliberately: per-threshold day-count variants (there are 5 wind-speed thresholds and 4 rain/snow-amount thresholds available; picked one representative each rather than all), mean temperature alone (redundant with degree-days), and anything requiring `climate-daily`/`ltce-*` (see above).
  - **Testing**: does *not* hit the live API in the committed test suite — `msc-geomet.client.spec.ts` mocks `fetch` with canned responses (covers URL construction, the bbox-widening loop, and error handling); `climate.service.spec.ts` mocks `MscGeometClient` (covers the element-ID mapping and missing-station/missing-element handling). A live third-party API is slow, rate-limited, and outside our control — not something a committed/CI test should depend on. Real-API behavior was confirmed once via a throwaway probe script (not committed) against Regina, SK (resolved to station "REGINA INT'L A", 3.6km away, 1981-2010 normals) and a mid-Atlantic point (correctly `dataAvailable: false` — no Canadian station within any search width).

- **`ClimateService.getCurrentConditions(lat, lng)`** — a second, deliberately *separate* lookup from `getClimateRiskProfile`, added after discussing forecast/real-time scope: normals are a stable structural baseline that shouldn't change hour to hour, but "is this pole under elevated load right now" is a genuinely different, time-varying question. Rather than build our own weather-prediction algorithm on top of the normals data (Environment Canada already publishes real forecasts — we have no ability to out-predict their actual model by statistically extrapolating from 30-year averages), this calls their live data directly.
  - Source: `citypageweather-realtime` — keyed to ~844 named Canadian cities/towns (e.g. `sk-32` = Regina), not a dense station grid. Resolved the same way as normals stations: widen a bounding-box search until a city point is found, rank by haversine distance. Extracted a shared `searchWidening` helper in `MscGeometClient` once this became the second place using that bbox-widen-and-rank pattern.
  - **Revision history on this one**: the first version surfaced EC's `warnings` array (active severe weather alerts, e.g. "ORANGE WARNING - HEAT") instead of current conditions. Dropped after review — warnings are free-text hazard descriptions that would need fragile string-matching to interpret, and don't distinguish pole-relevant hazards (wind/rain/ice) from irrelevant ones (heat, air quality). Replaced with the same collection's structured `currentConditions` block instead: wind speed/gust (km/h) and temperature (°C), both clean numbers directly comparable to the normals we already pull. Deliberately *not* including the `condition` text field (e.g. "Partly Cloudy") for the same fragility reason warnings were dropped.
  - `currentConditions` has no precipitation field at all (confirmed by sampling all ~844 cities) — it's an instantaneous station reading (temp/wind/pressure/humidity/dewpoint), not a rain gauge. Live precipitation would require `swob-realtime` instead (see above) — investigated, deferred as a separate task given its complexity.
  - Reads only `currentConditions` out of this collection's response. The full payload also contains a multi-day/hourly forecast tree (temperatures, wind, cloud/precip, UV, humidex, per 6-hour period) and the warnings array discussed above — both deliberately left unparsed.
  - Verified against real live data: Regina, SK returned 23.9°C, wind 15 km/h gusting to 29, from station "Regina Int'l Airport" (`yqr`) — matches what weather.gc.ca showed for Regina at the same time.
  - Not yet wired into `GET /viability` or blended with the structural score — still an open design question how a live, time-varying signal should combine with (or sit alongside) the stable soil+normals-based rating.
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
  - **Startup verification**: since the data isn't in git, `SlcDataRepository` checks that every required SLC file is present and readable *before* attempting to parse any of them. If the dataset (or `SLC_DATA_DIR`) is missing or incomplete, app startup fails immediately with one clear error naming exactly which files are missing and where to get them — instead of a cryptic `ENOENT` from inside the `shapefile` library.
  - **Field trim (2026-07-10 review)**: went through every parsed field and cut ones with no clear structural-stability argument for pole fall risk, to keep the profile focused on things a formula can actually justify a weight for:
    - `CRT.AWHC` (available water holding capacity) — an agronomic irrigation metric, not a structural one.
    - `CRT.CFRAG1`/`CFRAG2` (coarse fragment class) — no clear directional relationship to fall risk either way.
    - `SNT.ROOTRESTRI` (root restriction) — redundant with `CRT.DEPTH`/`RESTR_TYPE`, which already describe the same restrictive layer in more detail.
    - `CMP.SLOPE` (component-level coded slope class) — redundant with the landform table's numeric `LFS_SLOPE`, which is more precise and already reported via `getDominantLandform`.
    - `SLT.ORGCARB` (organic carbon %) — redundant with `SNT.KIND` (mineral vs. organic) at the resolution the profile needs.
    - Kept from SLT: `BD` (bulk density — bearing-capacity proxy), texture % (sand/silt/clay — cohesion/frost/liquefaction behavior), `KSAT` (how long soil stays weak after rain, a natural join point with climate/precipitation data later). Chose to keep the full layer table over collapsing to `DRAINAGE` class alone because we have no real pole-failure data to calibrate against — continuous physical values are more defensible to derive formula weights from via published geotechnical bearing-capacity relationships than assigning arbitrary weights to someone else's categorical judgment calls.

- **First API endpoint: `GET /viability?lat=<n>&lng=<n>`** (`src/viability/`) — the public entry point for pole viability lookups, and the one URL the outside world will call. For now it's a thin pass-through to `SoilService.getSoilRiskProfile` (no combined score yet — that comes once climate data and the scoring formula exist). The response shape here is expected to change once soil becomes one input among several rather than the whole response.
  - Only `lat`/`lng` are accepted right now — city-name input needs geocoding, which isn't built (see open questions).
  - Query params are validated with `class-validator`'s `@IsLatitude`/`@IsLongitude` (via a global `ValidationPipe` in `main.ts`, `transform: true` so query strings coerce to numbers first). Missing or out-of-range coordinates get a `400` with a clear message before ever reaching `SoilService` — no manual bounds-checking needed in the controller.
  - A location outside SLC coverage (e.g. open ocean) is a normal `200` with `dataAvailable: false`, not an error — it's a valid answer ("no data here"), not a failure.
  - Verified live: started the app and curled the endpoint directly (not just through tests) for the golden path (Regina, SK), missing params, an out-of-range latitude, and an ocean point — all behaved as above.

## Assumptions

Neither dataset alone tells us anything about pole failure — these are our own hypotheses about how the collected factors combine into fall risk, written down so the eventual formula's weights trace back to a stated reason rather than an arbitrary number. Unverified against real outcomes (no pole-failure data exists to check against — see Problem); revise freely as research or the formula work surfaces something better.

- **Rain weakens soil, and how long it stays weak depends on drainage.** Saturated soil loses shear strength/bearing capacity — a pole is more likely to lean or fall during or shortly after a heavy rain event than in dry conditions. `climate.normals.totalPrecipitationMm` is the moisture load; `soil.layers[].saturatedHydraulicConductivity` (`KSAT`) and `soil.drainage.drainageClass` together describe how fast that moisture drains back out. High precipitation + low `KSAT`/poor drainage should compound (soil that's both frequently wetted and slow to dry out) more than either factor alone.
- **Cold intensity plus soil moisture drives frost heave.** Freeze-thaw cycling heaves and shifts whatever's anchored in the ground. `climate.normals.degreeDaysBelowZero`/`frostFreePeriodDays` describe how much freezing the ground sees; `soil.drainage.waterTableClass` and clay content (`soil.layers[].clayPercent`) describe how much water is present in the soil to actually freeze and expand — dry, well-drained soil has little to heave even under heavy freezing.
- **Wind loads the pole directly, independent of soil.** `climate.normals.meanWindSpeedKmh`/`highWindDaysPerYear` act on the pole's above-ground structure (lateral force against its height and any attached lines), not on the soil. This is the one factor pair that isn't soil-mediated — it should combine with the footing's resistance (`soil.depthToRestriction`, bearing capacity) rather than with soil-moisture factors.
- **Slope compounds whatever the base soil/moisture risk already is, rather than being independent.** `soil.landform.slopePercent` on its own doesn't move a vertical pole, but on saturated or freeze-thaw-active soil it enables lateral creep/slide that flat ground wouldn't. Likely a multiplier on other factors rather than an additive term of its own.

## Open questions

- Now that both `SoilService` and `ClimateService` exist as raw-factor lookups, how do the Assumptions above actually become formula weights/thresholds? This is the next real design step.
- How should the live `getCurrentConditions` signal combine with the stable structural score — a temporary multiplier while wind/temp are extreme, a separate field in the response, something else? Also changes the caching story: the structural score is stable/cacheable, current conditions are not.
- Is live precipitation (`swob-realtime`) worth the integration complexity, or is `climate-normals`' `totalPrecipitationMm` (long-term average) sufficient for the formula?
- Should `climate-daily`/`ltce-*` get pulled in later for more precise freeze-thaw-cycle counts and worst-case wind/precip events, or do the `climate-normals`-based proxies turn out to be good enough?
- Should soil ingestion move to a real spatial database (e.g. PostGIS) once combined with climate data/if the dataset grows, or does in-memory-at-startup stay sufficient?
- The per-table field codes (e.g. `DRAINAGE` class values, `RESTR_TYPE` codes) aren't in the top-level model doc — need to pull the legend from each table's own page (e.g. `slc/v3.2/crt/index.html`, `.../lst/index.html`) before the formula can interpret the coded values `SoilService` now returns.
- Does "city name" input require geocoding to lat/long first (and via what service)?
- Does the formula distinguish telephone poles vs. electrical poles (different material, height, load standards)?
- What does the combined API response look like once soil + climate + a score are all present — a raw score, a risk category (low/medium/high), a probability, contributing factors breakdown? `GET /viability` currently returns only the soil profile; this will need to change.
- Any persistence needed (caching climate lookups so we're not re-hitting MSC GeoMet on every request, storing formula versions/results), or is this fully stateless per-request?

## Development

Standard NestJS project — see `CLAUDE.md` for commands and conventions.

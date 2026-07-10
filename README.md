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
  - **Defensive per-record parsing (2026-07-10 fix)**: an independent code review flagged that `.map()`ing over a bbox response's features accessed nested fields (e.g. `conditions.wind.speed.value.en`) with no runtime validation — the TS interfaces are a compile-time assertion only, not a guarantee about the actual JSON. One malformed candidate anywhere in a ~50-candidate response (a station outage, an EC schema drift) would throw and fail the *entire* request, even for an otherwise-perfectly-resolvable location. `MscGeometClient` now validates each feature's required fields explicitly and skips (with a logged warning) any that fail, via a shared `parseFeatures` helper used by all three parsing sites (`climate-stations`, `climate-normals`, `citypageweather-realtime`) — one bad record no longer takes down the rest of the candidates.

- **`ClimateService.getCurrentConditions(lat, lng)`** — a second, deliberately *separate* lookup from `getClimateRiskProfile`, added after discussing forecast/real-time scope: normals are a stable structural baseline that shouldn't change hour to hour, but "is this pole under elevated load right now" is a genuinely different, time-varying question. Rather than build our own weather-prediction algorithm on top of the normals data (Environment Canada already publishes real forecasts — we have no ability to out-predict their actual model by statistically extrapolating from 30-year averages), this calls their live data directly.
  - Source: `citypageweather-realtime` — keyed to ~844 named Canadian cities/towns (e.g. `sk-32` = Regina), not a dense station grid. Resolved the same way as normals stations: widen a bounding-box search until a city point is found, rank by haversine distance. Extracted a shared `searchWidening` helper in `MscGeometClient` once this became the second place using that bbox-widen-and-rank pattern.
  - **Revision history on this one**: the first version surfaced EC's `warnings` array (active severe weather alerts, e.g. "ORANGE WARNING - HEAT") instead of current conditions. Dropped after review — warnings are free-text hazard descriptions that would need fragile string-matching to interpret, and don't distinguish pole-relevant hazards (wind/rain/ice) from irrelevant ones (heat, air quality). Replaced with the same collection's structured `currentConditions` block instead: wind speed/gust (km/h) and temperature (°C), both clean numbers directly comparable to the normals we already pull. Deliberately *not* including the `condition` text field (e.g. "Partly Cloudy") for the same fragility reason warnings were dropped.
  - `currentConditions` has no precipitation field at all (confirmed by sampling all ~844 cities) — it's an instantaneous station reading (temp/wind/pressure/humidity/dewpoint), not a rain gauge. Live precipitation would require `swob-realtime` instead (see above) — investigated, deferred as a separate task given its complexity.
  - Reads only `currentConditions` out of this collection's response. The full payload also contains a multi-day/hourly forecast tree (temperatures, wind, cloud/precip, UV, humidex, per 6-hour period) and the warnings array discussed above — both deliberately left unparsed.
  - Verified against real live data: Regina, SK returned 23.9°C, wind 15 km/h gusting to 29, from station "Regina Int'l Airport" (`yqr`) — matches what weather.gc.ca showed for Regina at the same time.
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

- **API endpoint: `GET /viability?lat=<n>&lng=<n>`** (`src/viability/`) — the public entry point for pole viability lookups. Returns **only** `PoleViabilityScore` — `dataAvailable`, `overallRisk`, `shortTermRisk`, `longTermRisk` — not the raw soil/climate/current-conditions profiles or the contributing-factors breakdown that produced it. Those are logged instead (see "Scoring formula" > Logging below); the response is deliberately minimal display output, revised down from an earlier version that also echoed the raw profiles.
  - `PoleViabilityService` (`src/viability/pole-viability.service.ts`) orchestrates the lookup: fetches soil + climate normals + current conditions in parallel (`Promise.all`), hands them to `RiskScoringService`, logs the three raw input profiles at full detail, and returns just the score. Kept separate from the controller so this orchestration is unit-testable without HTTP, and separate from `RiskScoringService` so the scoring math stays a pure function testable with fixed inputs.
  - Only `lat`/`lng` are accepted right now — city-name input needs geocoding, which isn't built (see open questions).
  - Query params are validated with `class-validator`'s `@IsLatitude`/`@IsLongitude` (via a global `ValidationPipe` in `main.ts`, `transform: true` so query strings coerce to numbers first). Missing or out-of-range coordinates get a `400` with a clear message before ever reaching any service — no manual bounds-checking needed in the controller.
  - A location with no soil/climate coverage (e.g. open ocean) is a normal `200` with `dataAvailable: false` and every risk field `null`, not an error — it's a valid answer ("no data here"), not a failure.
  - **Testing**: the e2e test (`test/viability.e2e-spec.ts`) mocks `MscGeometClient` via NestJS's `overrideProvider` rather than hitting the live climate API — same reasoning as the climate unit tests, extended to e2e: still exercises the real HTTP/validation/DI stack end-to-end, just without a flaky live network dependency in CI. Soil still reads the real local `landscape_data/` files (static data we control, not a live dependency).
  - Verified live: started the app and curled the endpoint directly (not just through tests) for the golden path (Regina, SK) and an ocean point (`dataAvailable: false`, every risk field `null`) — confirmed the response contains exactly the four score fields and nothing else, while the server log carries the full raw inputs and contributing-factors breakdown.

## Assumptions

Neither dataset alone tells us anything about pole failure — these are our own hypotheses about how the collected factors combine into fall risk, written down so the eventual formula's weights trace back to a stated reason rather than an arbitrary number. Unverified against real outcomes (no pole-failure data exists to check against — see Problem); revise freely as research or the formula work surfaces something better.

- **Rain weakens soil, and how long it stays weak depends on drainage.** Saturated soil loses shear strength/bearing capacity — a pole is more likely to lean or fall during or shortly after a heavy rain event than in dry conditions. `climate.normals.totalPrecipitationMm` is the moisture load; `soil.layers[].saturatedHydraulicConductivity` (`KSAT`) and `soil.drainage.drainageClass` together describe how fast that moisture drains back out. High precipitation + low `KSAT`/poor drainage should compound (soil that's both frequently wetted and slow to dry out) more than either factor alone.
- **Cold intensity plus soil moisture drives frost heave.** Freeze-thaw cycling heaves and shifts whatever's anchored in the ground. `climate.normals.degreeDaysBelowZero`/`frostFreePeriodDays` describe how much freezing the ground sees; `soil.drainage.waterTableClass` and clay content (`soil.layers[].clayPercent`) describe how much water is present in the soil to actually freeze and expand — dry, well-drained soil has little to heave even under heavy freezing.
- **Wind loads the pole directly, independent of soil.** `climate.normals.meanWindSpeedKmh`/`highWindDaysPerYear` act on the pole's above-ground structure (lateral force against its height and any attached lines), not on the soil. This is the one factor pair that isn't soil-mediated — it should combine with the footing's resistance (`soil.depthToRestriction`, bearing capacity) rather than with soil-moisture factors.
- **Slope compounds whatever the base soil/moisture risk already is, rather than being independent.** `soil.landform.slopePercent` on its own doesn't move a vertical pole, but on saturated or freeze-thaw-active soil it enables lateral creep/slide that flat ground wouldn't. Likely a multiplier on other factors rather than an additive term of its own.

## Scoring formula

`RiskScoringService` (`src/scoring/risk-scoring.service.ts`) turns the raw soil/climate/current-conditions profiles into `PoleViabilityScore`. Structure requested explicitly: compile soil data, combine with live weather for the location, produce a **long-term risk** (structural, from soil + 30-year climate normals) and a **short-term risk** (from live current conditions), then an **overall risk** clamped to `[0, 1]`. Every threshold below is a documented, researched guess — there's no pole-failure data to calibrate against (see Problem) — so treat this as a first defensible draft, not a validated model. Full reasoning lives in code comments next to each constant; this section is the map.

**`dataAvailable`**: if soil, climate normals, or current conditions is itself unavailable for the location, every risk field is `null`, not a partial/best-effort number — a long-term score missing its climate half (or vice versa) isn't a lower-confidence version of the real answer, it's missing an input the formula depends on.

### Soil code legends

The formula needed the actual meaning of SLC's coded values, not just field names — pulled from AAFC's per-field legend pages (`sis.agr.gc.ca/cansis/nsdb/soil/v2/snt/*.html`, `.../slc/v3.2/crt/*.html`), closing an earlier open question:
- **`DRAINAGE`** (best → worst): `VR` very rapid, `R` rapid, `W` well, `MW` moderately well, `I` imperfect, `P` poor, `VP` very poor.
- **`WATERTBL`**: `NO` never present, `YU` present (unspecified period), `YN` non-growing season, `YG` growing season, `YB` always present.
- **`KIND`**: `M` mineral, `O` organic, `N` true non-soil (airport/lake), `U` unclassified.
- **`DEPTH`** class (root/footing depth before bedrock/hardpan/water table): `1` <25cm, `2` 25-49cm, `3` 50-74cm, `4` 75-99cm, `5` ≥100cm, `-`/missing non-applicable (e.g. rock at surface).

### Long-term risk — structural baseline (soil + climate normals)

A weighted combination of six sub-scores (each independently `[0, 1]`), directly implementing the four relationships in "Assumptions" above:

| Sub-score | Weight | Inputs | What it captures |
|---|---|---|---|
| `footingDepthRisk` | 0.25 | average of `depthClassRisk` (`soil.depthToRestriction.depthClass`) and `bulkDensityRisk` (`soil.layers[0].bulkDensity`) | How deep a footing can go before hitting bedrock/hardpan/water table, **and** how much resistance the soil in that embedment zone actually provides. Depth class alone only answers the first question — see "Bulk density" below for why the second was added. |
| `soilWetnessRisk` | 0.20 | `drainageClass` + `waterTableClass` (ordinal legends above), amplified by clay % and slope % | Static "how wet does this soil typically get" — the drainage/water-table classification, amplified because clay is strong dry but weak wet, and slope lets saturated/thawing soil creep. |
| `saturationDurationRisk` | 0.15 | `climate.normals.totalPrecipitationMm` × `soil.layers[0].saturatedHydraulicConductivity` (`KSAT`) | Dynamic "how long does it stay wet after rain" — **multiplicative**, not additive: heavy rain on fast-draining soil isn't a saturation problem, slow drainage in a dry climate rarely gets saturated. Direct implementation of the rain/`KSAT` Assumption. |
| `windRisk` | 0.20 | `climate.normals.meanWindSpeedKmh` + `highWindDaysPerYear`, amplified by `footingDepthRisk` | Wind loads the pole directly, independent of soil moisture (per Assumptions) — so it's amplified by footing depth (anchor resistance), not by wetness. |
| `freezeThawRisk` | 0.20 | `climate.normals.frostFreePeriodDays` + `degreeDaysBelowZero`, amplified by `soilWetnessRisk` | Freeze-thaw cycle exposure from climate normals, amplified by soil wetness — dry soil freezing doesn't heave much. |
| `organicSoilRisk` | additive bump, not part of the weighted split | `soil.drainage.kind` | Flat +0.3 for organic (`'O'`) soil (materially worse bearing capacity), +0.1 for unclassified/non-soil (genuinely unknown, not "safe by default"), 0 for ordinary mineral soil. |

`longTermRisk = clamp01(weighted sum + organicSoilRisk)`.

Every raw value is mapped to `[0, 1]` via `linearRisk(value, zeroRiskAt, oneRiskAt)` (`src/scoring/utils/risk-math.util.ts`) — linear interpolation between two reference points, clamped past either end; `zeroRiskAt > oneRiskAt` expresses an inverted relationship (e.g. a *shorter* frost-free period means *higher* risk). Reference points were chosen from the realistic Canadian range for each variable (e.g. 200mm-1200mm/yr precipitation spans dry Prairies to wet coastal BC; 10cm/hr-0.1cm/hr `KSAT` spans fast sandy to very slow heavy clay) — informed estimates, not measured thresholds.

**Bulk density (2026-07-10 addition)**: an external environmental-scientist review (see "External review" below) flagged that `SLT.BD` was collected and documented as a "bearing-capacity proxy" but never actually read anywhere in the formula — a real gap between stated intent and implementation. `calculateBulkDensityRisk` now maps it via `linearRisk(bulkDensity, 1.6, 0.9)` (1.6 g/cm³ dense/compact → 0 risk, 0.9 g/cm³ loose/organic-influenced → max risk — the typical range for Canadian mineral soils), averaged with `depthClassRisk` into `footingDepthRisk`. Rationale per the review: real overturning resistance depends on soil strength within the embedment zone, not just whether a footing can physically reach a given depth before hitting rock/hardpan.

### Short-term risk — live modifier (current conditions vs. normals/soil)

Two sub-scores:
- **`windAnomalyRisk`** — the larger of (a) current wind gust vs. this location's *normal* mean wind (anomaly), and (b) current gust against an absolute storm-force floor (40-100 km/h). Anomaly alone would under-react in a location whose "normal" is already windy; an absolute floor alone would miss a smaller-but-unusual local spike.
- **`freezeThawTransitionRisk`** — peaks when current temperature is exactly 0°C (the active freeze-thaw boundary, where ice lens formation actually happens), tapering to 0 by ±5°C away, amplified by `soilWetnessRisk` (nothing to freeze in dry soil).

`shortTermRisk = clamp01(windAnomalyRisk * 0.6 + freezeThawTransitionRisk * 0.4)`.

**No live precipitation factor** — `citypageweather-realtime`'s `currentConditions` has no rain gauge field (see "Climate data" above); this is a known gap in the short-term side, not an oversight. `swob-realtime` would fill it but was deferred for complexity reasons.

### Combining into `overallRisk`

`overallRisk = clamp01(longTermRisk + shortTermRisk * 0.3)` — **additive**, not a blended average. A blended average (e.g. `0.7 * longTerm + 0.3 * shortTerm`) would let a calm moment artificially pull down an inherently risky location's score; additive means calm short-term conditions never discount the structural baseline, but genuinely elevated live conditions (high wind, active freeze-thaw) can meaningfully push the score up on top of it.

### Worked example (verified against live data)

Regina, SK (deep well-drained soil, BD 1.2 g/cm³, low slope, moderate wind/freeze-thaw normals, calm 23.9°C conditions with a 29 km/h gust): `longTermRisk ≈ 0.242`, `shortTermRisk ≈ 0.159`, `overallRisk ≈ 0.290` — a real but unremarkable risk level, which matches expectations for an ordinary prairie city block. (`longTermRisk` rose from an earlier ≈0.158 once bulk density was wired in — BD 1.2 g/cm³ isn't maximally dense, so it's no longer "free" the way depth class 5 alone implied.)

### Logging

`GET /viability` returns **only** `PoleViabilityScore`: `dataAvailable`, `overallRisk`, `shortTermRisk`, `longTermRisk` — each rounded to 2 decimal places (`roundTo2Decimals` in `risk-math.util.ts`). Everything else is logged, not returned, across two services:
- `RiskScoringService` logs the full-precision `longTermRisk`/`shortTermRisk`/`overallRisk` plus the entire `contributingFactors` breakdown (`[RiskScoringService] Viability score for (lat, lng): {...}`) — the internal `ViabilityRiskBreakdown` type (`pole-viability-score.interface.ts`) is fully computed either way, just logged instead of returned.
- `PoleViabilityService` logs the three raw input profiles it fetched — soil, climate normals, current conditions — in full (`[PoleViabilityService] Viability inputs for (lat, lng): soil=..., climate=..., currentConditions=...`).

Rationale: the response is meant for minimal display/consumption; the raw inputs and granular breakdown are an operational/debugging concern that shouldn't bloat every request's payload, but shouldn't be lost either. Tests for the detailed sub-factor math (`risk-scoring.service.spec.ts`) capture the logged breakdown via a `Logger.prototype.log` spy rather than asserting on the response directly.

### External review (2026-07-10)

Had an environmental/geotechnical-science review done against real literature (utility pole-setting standards, soil physics, Canadian climatology) before trusting the formula further. Findings:
- **Validated as well-anchored, not just plausible**: the wind reference points (10-30 km/h mean) track real EC normals closely (Regina/Lethbridge ~18.3-18.4 km/h; St. John's, Canada's windiest city, ~22-24 km/h); the `KSAT` range (10→0.1 cm/hr) matches published soil-physics values for sand vs. clay loam almost exactly; drainage-class-as-strength-proxy is consistent with published shear-strength-vs-saturation research (50-80% strength loss from optimum to saturated).
- **Bulk density gap** — fixed, see above.
- **Precipitation (200-1200mm) and degree-days-below-zero (200-3000)/frost-free-period (220-60 days) ranges saturate before the true extremes** of coastal BC (2000-3000mm/yr) and the far north are reached — acceptable as "risk saturates past a point," but it means the formula can't distinguish e.g. a cold Prairie city from an Arctic community. Not fixed; noted as a known limitation below.
- **Soil wetness is currently counted in three places** (direct 20% weight, amplifies `freezeThawRisk`, amplifies `freezeThawTransitionRisk`) — may be intentional (wetness genuinely compounds with freezing physically) but wasn't a deliberate weighting decision. Open question below.

### Known limitations

Real, documented physical failure mechanisms this formula does not model at all — flagged by the external review, recorded here rather than silently absent. None of these are oversights so much as explicit scope calls given what data is actually available (see Problem: no per-pole data exists), but they should be visible, not implicit:

- **Ice/freezing-rain load** — the single biggest scientific gap for a Canada-scoped tool. The January 1998 ice storm — Canada's most significant infrastructure-collapse event on record — felled roughly 30,000 utility poles; iced conductors present far more sail area, so ice load compounds multiplicatively with wind in real failure mechanics. Neither `windRisk` nor any other factor accounts for icing at all. Worth checking whether `climate-normals` has a freezing-rain/glaze element before building anything new.
- **Guy-wire/anchoring** — real distribution poles, especially at corners/dead-ends, often get their primary overturning resistance from guying, not soil alone. This formula has no way to know whether a given pole is guyed, so it can only ever estimate *unguyed* site risk.
- **Quick/sensitive (Leda) clay landslides** — a real, well-documented, Canada-specific hazard in the St. Lawrence/Ottawa Valley region (fatal historical events: Notre-Dame-de-la-Salette 1908, St-Jean-Vianney 1971, Lemieux 1993, St-Jude 2010). This is a distinct, sudden/catastrophic failure mode from the generic slope-creep model `slopeAmplifier` represents — can occur on very gentle slopes when the toe is eroded or the clay disturbed. SLC's taxonomic fields may or may not tag this cleanly; not currently checked for.
- **Erosion/scour at the pole base** — proximity to a riverbank or drainage channel isn't captured by any SLC field currently used; undermining is a distinct failure mechanism from the saturation/bearing-capacity pathway already modeled.
- **Permafrost engineering** — for northern locations where `degreeDaysBelowZero`/`frostFreePeriodDays` already clamp to max risk (see External review above), real infrastructure there typically uses entirely different foundation techniques (piles, thermosyphons) specifically because seasonal freeze-thaw modeling doesn't apply the same way in perennially frozen ground. "Max freeze-thaw risk" under this formula is a different physical regime in the true north than in, say, Winnipeg.
- **Wood decay/rot** — worth stating plainly: published estimates attribute roughly 60-85% of *actual* real-world wood pole failures to fungal core rot, not any site/climate/soil mechanism at all. This is a genuine, deliberate scope boundary (no per-pole age/material/species/inspection data exists to model it against) rather than an oversight — this tool estimates *site* risk, not overall failure probability, and the single largest real-world cause of pole failure is structurally outside what it can ever answer.

## Score cache

`ScoreCacheRepository` (`src/score-cache/`) persists one row per exact `(lat, lng)` in a SQLite file — the "very simple database" the user asked for. Chose SQLite via [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) over anything heavier: synchronous (no async ceremony for what's a handful of tiny queries), file-based (no server process to run/manage), and it matches this project's existing pattern of small direct-SQL/direct-HTTP repository classes rather than pulling in an ORM.

**Cache semantics** — a specific hybrid, not a plain read-through cache:
- **Miss** (`findByLocation` returns nothing): fetch soil + climate normals + current conditions, compute the score, and `upsertFullScore` it — as long as soil + climate normals both resolved (`cacheable` is non-null). A current-conditions failure alone doesn't block this — see "Cache eligibility" below.
- **Hit**: skip fetching soil and climate normals entirely (`SoilService`/`ClimateService.getClimateRiskProfile` are never called) and reuse the stored `longTermRisk` — genuinely stable, since it's derived from soil + 30-year climate normals. But **always** fetch live current conditions and recompute `shortTermRisk` fresh via `RiskScoringService.calculateShortTermRiskOnly` — a repeat query should never return day-old wind/temperature data. The row's `shortTermRisk`/`overallRisk`/`updatedAt` are updated afterward; `longTermRisk`/`computedAt` are left untouched.
- This means the table holds each location's *most recent* computation only, not a history of every past one — "store all scores" was interpreted as "every computed score gets persisted/kept current," not as an append-only log.

**Cache eligibility is decoupled from current-conditions availability (2026-07-10 fix)**: `cacheable` used to require soil *and* climate *and* current conditions all succeeding. That meant a location with perfectly good soil/climate data could never be cached at all if `citypageweather-realtime` simply had no nearby city point for it on a given request (plausible for real, SLC/climate-station-covered locations far from all ~844 named cities) — every request for that location paid the full soil-parse + climate-normals round-trip forever. `longTermRisk` only ever depended on soil + climate, so `RiskScoringService` now computes and returns `cacheable` as soon as those two resolve, independent of current conditions. When current conditions do fail: `score.dataAvailable` is `true` (there's a real structural score), `shortTermRisk` is `null`, and `overallRisk` falls back to `longTermRisk` alone (nothing to add without a live reading) — for both the cache-miss path (`calculateViabilityScore`) and the cache-hit path (`calculateShortTermRiskOnly`, which falls back to the already-cached `longTermRisk`). The DB row itself still needs a non-null `short_term_risk` (schema constraint), so `PoleViabilityService` stores `0` in that case — a later cache-hit request refreshes it for free once current conditions succeed.

**Why `longTermRisk` alone isn't enough to cache**: `shortTermRisk`'s sub-calculations need more than just the cached number — `freezeThawTransitionRisk` needs `soilWetnessRisk` (a soil-derived intermediate) and `windAnomalyRisk` needs `meanWindSpeedKmh` (a climate-normals value). Both are persisted alongside `longTermRisk` in the cache row (`CacheableLongTermRisk` in `pole-viability-score.interface.ts`) specifically so a cache hit can recompute short-term risk correctly without re-fetching soil or climate normals just to get those two numbers back.

**Config**: DB file defaults to `data/viability-scores.db` (gitignored, same pattern as `landscape_data/`), overridable via `SCORE_CACHE_DB_PATH`. Tests set this to `:memory:` — isolated per test run, no file left on disk, and no risk of one test's cached row silently changing another test's expected behavior (the e2e suite in particular always queries the same handful of coordinates, so without this a second `test:e2e` run would take the cache-hit path instead of cache-miss).

**Verified**: live server, two requests to the same location — second request's log line read `Cache hit for (...) — reused longTermRisk, recomputed shortTermRisk`, and the SQLite row showed `computed_at` unchanged while `updated_at` advanced. New e2e test hits a location twice and asserts the mocked climate client's station/normals lookups were called exactly once (not twice) while current-conditions was called twice — proving the skip-on-hit behavior, not just trusting the log message.

## Code review (2026-07-10)

Independent review of the full codebase (soil/climate/scoring/score-cache/viability), against real failure scenarios rather than style. Two findings were fixed immediately (see their sections above for detail): a malformed record from the live climate API could crash an otherwise-healthy request (now skipped with a warning, not fatal), and cache eligibility was wrongly gated on current-conditions succeeding (now decoupled). Remaining findings, not yet acted on:
- No timeout on outbound `fetch` calls to MSC GeoMet — a stalled upstream connection currently hangs the request indefinitely rather than failing fast.
- No de-duplication of concurrent identical cache-miss requests — N simultaneous requests for the same new location each independently redo the full soil+climate lookup (not a correctness bug, the upsert is idempotent, just duplicate upstream load).
- Unbounded score-cache growth — no TTL/eviction/row cap; every unique `(lat, lng)` gets a permanent row.
- `numOrNull`'s `-9` "no data" sentinel is applied uniformly to every SLC numeric field; worth spot-checking against AAFC's per-field docs rather than assuming it holds everywhere.
- No auth/rate-limiting on the public endpoint — reasonable for this project's current stage, flagged for if it's ever exposed beyond a trusted network.

## Open questions

- **The formula's weights/thresholds are an unvalidated first draft.** Every constant in `risk-scoring.service.ts` is a documented, researched guess (see "Scoring formula" above), not fitted to real outcomes — there's no pole-failure data to calibrate against. Revisit once there's any real signal (even informal — known problem poles, utility company incident data) to check the formula's outputs against.
- Is `soilWetnessRisk` being counted three times (direct weight + amplifying `freezeThawRisk` + amplifying `freezeThawTransitionRisk`) a deliberate emphasis worth keeping, or accidental overweighting worth dialing back? Flagged by external review, not yet decided.
- Should the ice/freezing-rain gap (see Known limitations) be addressed by checking `climate-normals` for a freezing-rain/glaze element, and if so, does it fold into `windRisk` (compounds with wind per real failure mechanics) or become its own factor?
- `RESTR_TYPE`'s own code legend (`BN`/`SA`/`CT`/`LI`/etc. — see `soil_name_canada` restr_type.html) exists but isn't used in scoring yet; `footingDepthRisk` currently relies on `DEPTH` class + bulk density, which already captures "how deep, and how strong" without needing to weight the ~10 restriction-cause codes individually. Revisit if the formula ever needs to distinguish e.g. bedrock (immovable) from a softer restriction.
- Is live precipitation (`swob-realtime`) worth the integration complexity, or is `climate-normals`' `totalPrecipitationMm` (long-term average) sufficient for the formula? Its absence is the biggest known gap on the short-term side.
- Should `climate-daily`/`ltce-*` get pulled in later for more precise freeze-thaw-cycle counts and worst-case wind/precip events, or do the `climate-normals`-based proxies turn out to be good enough?
- Should soil ingestion move to a real spatial database (e.g. PostGIS) once combined with climate data/if the dataset grows, or does in-memory-at-startup stay sufficient?
- Does "city name" input require geocoding to lat/long first (and via what service)?
- Does the formula distinguish telephone poles vs. electrical poles (different material, height, load standards)? Currently one formula for any pole type.
- **Persistence — partially resolved**: `longTermRisk` is now cached per location (see "Score cache" above), cutting a cache-hit request down to just a live current-conditions call. Still fully live/stateless: the initial cache-miss soil+climate-normals lookups, and every request's current-conditions fetch. Not yet addressed: cache invalidation (soil data never changes, but is 30-year climate normals ever revised, and would we know?), and no formula-version tracking on cached rows — if the formula changes, old cached `longTermRisk` values silently keep using whatever formula computed them.

## Development

Standard NestJS project — see `CLAUDE.md` for commands and conventions.

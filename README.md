# Pole Viability

An API that estimates how likely a pole (telephone or electrical/utility pole) is to fall, based on soil and climate conditions at a given location in Canada.

**Status**: Functional research prototype. Soil and live climate data feed a documented scoring formula behind a cached API. Independently reviewed twice — once for domain-science soundness, once for engineering correctness (see [Review & validation](#review--validation)). Not calibrated against real pole-failure outcomes; see [Problem](#problem).

## Contents

- [Problem](#problem)
- [API](#api)
- [Architecture](#architecture)
- [Scoring formula](#scoring-formula)
- [Assumptions](#assumptions)
- [Known limitations](#known-limitations)
- [Review & validation](#review--validation)
- [Open questions](#open-questions)
- [Development](#development)

## Problem

No dataset of real, specific poles (age, material, height, install date, inspection history) exists to train or calibrate a model against. This is a research-driven project: the risk formula is our own, built from publicly available soil and climate data and informed by research into what actually contributes to pole failure — wind load, soil saturation, freeze-thaw cycling, soil bearing capacity. Every weight and threshold in the formula is a documented, researched estimate, not a fitted one.

**Scope: Canada only.** Both data sources (soil and climate) are Canada-specific.

## API

```
GET /viability?lat=<number>&lng=<number>
```

```bash
curl "https://<host>/viability?lat=50.4452&lng=-104.6189"
```

```json
{
  "dataAvailable": true,
  "overallRisk": 0.29,
  "shortTermRisk": 0.16,
  "longTermRisk": 0.24
}
```

- `overallRisk`, `shortTermRisk`, `longTermRisk` — `[0, 1]`, rounded to 2 decimal places. See [Scoring formula](#scoring-formula) for what each represents.
- `dataAvailable: false` (with every risk field `null`) is a normal `200`, not an error — it means the location has no soil or climate coverage (e.g. open ocean, outside Canada). That's a valid answer, not a failure.
- Missing or out-of-range `lat`/`lng` return `400` with a validation message.
- Only `lat`/`lng` are supported today; city-name input isn't built yet (see [Open questions](#open-questions)).

Only the score is returned — the raw soil/climate profiles and the full per-factor breakdown that produced it are logged server-side, not returned in the response. See [Logging](#logging) below.

## Architecture

```
lat/lng ──▶ SoilService ────────┐
        ──▶ ClimateService ─────┼──▶ RiskScoringService ──▶ PoleViabilityScore
        ──▶ ScoreCacheRepository┘        (cache read/write)
```

### Soil data

Source: [Soil Landscapes of Canada (SLC) v3.2](https://sis.agr.gc.ca/cansis/nsdb/slc/index.html), Agriculture and Agri-Food Canada — a 1:1,000,000-scale national soil survey, distributed as a shapefile plus several related `.dbf` tables joined by key (not a live API):

| File | Table | Join key(s) | Role |
|---|---|---|---|
| `ca_all_slc_v3r2.shp`/`.dbf` | PAT | `POLY_ID` | Polygon geometries — spatial index for lat/lng → polygon lookup |
| `ca_all_slc_v3r2_cmp.dbf` | CMP | `POLY_ID` → `CMP_ID`, `SOIL_ID` | Soil component(s) per polygon with `PERCENT` coverage |
| `ca_all_slc_v3r2_crt.dbf` | CRT | `CMP_ID` | Depth to restriction (bedrock/hardpan/water table) |
| `soil_name_canada_*.dbf` | SNT | `SOIL_ID` | Drainage class, water table class, mineral/organic kind |
| `soil_layer_canada_*.dbf` | SLT | `SOIL_ID` + `LAYER_NO` | Per-depth-layer physical properties: bulk density, texture, hydraulic conductivity |
| `ca_all_slc_v3r2_lst.dbf` + `_ldt.dbf` | LST, LDT | `POLY_ID` → `LFS_ID` | Landscape segments and their actual slope gradient |
| `_let.dbf`, `_eft.dbf`, `_lat.dbf` | LET, EFT, LAT | various | Landform extent, ecological classification, land/water split — not used (see below) |

**`SlcDataRepository`** (`src/soil/`) parses the shapefile and all core `.dbf` tables once at startup into in-memory `Map`s (~12k polygons, small enough to hold for the process lifetime — no database needed). Point → polygon resolution is a bounding-box pre-filter followed by an exact [`@turf/boolean-point-in-polygon`](https://www.npmjs.com/package/@turf/boolean-point-in-polygon) test. Where a polygon has multiple soil components or landscape segments, the dominant one (highest `PERCENT`) is used rather than a weighted average.

The dataset (62MB) isn't committed to git — anyone working on this needs to download it from AAFC and place it in `landscape_data/` (or point `SLC_DATA_DIR` at it). Since the data isn't guaranteed to be present, startup checks every required file exists and fails immediately with a clear message naming what's missing, rather than a cryptic error partway through parsing.

**Fields parsed**, chosen for a direct line to pole fall risk: depth-to-restriction and restriction type (footing depth ceiling), drainage class and water table class (soil strength/saturation), bulk density and texture — sand/silt/clay % (bearing capacity, cohesion behavior), saturated hydraulic conductivity (how long soil stays weak after rain), slope gradient (lean/creep risk), mineral-vs-organic kind (bearing capacity). Fields deliberately left out for having no clear structural-stability argument: available water-holding capacity (an irrigation metric, not structural), coarse fragment class, root-restriction flag (redundant with depth-to-restriction), component-level coded slope class (redundant with the more precise numeric slope), organic carbon % (redundant with mineral/organic kind).

### Climate data

Source: [MSC GeoMet](https://api.weather.gc.ca/openapi?f=json), Environment Canada's live API (not the historical climate.weather.gc.ca website — a real-time OGC API). Unlike soil, this is a live third-party dependency: `ClimateService`/`MscGeometClient` (`src/climate/`) make live HTTP calls per lookup rather than indexing a static dataset, fetching only what one lookup needs.

Two independent signals:
- **30-year normals** (`climate-normals` collection) — a stable structural baseline. Resolved via `climate-stations`, filtered to stations that report normals, found by a bounding-box search that widens progressively until a station turns up, ranked by [haversine distance](https://en.wikipedia.org/wiki/Haversine_formula). Five elements are pulled, each chosen for a direct line to pole risk: mean wind speed, annual high-wind-day frequency, total precipitation, frost-free period length, and degree-days below 0°C.
- **Live current conditions** (`citypageweather-realtime` collection) — wind speed/gust and temperature, resolved the same bbox-search way against ~844 named Canadian cities. Deliberately structured numeric fields, not the same collection's free-text severe-weather warnings or condition text — those would need fragile string-matching to interpret and don't distinguish pole-relevant hazards (wind/ice) from irrelevant ones (heat, air quality). This collection has no precipitation field at all; live precipitation would require a different, considerably more complex collection (`swob-realtime`, a raw observation stream) and isn't implemented.

Deferred, and why: `climate-daily`/`ltce-*` would give more precise freeze-thaw/extreme-event counts than the normals-based proxies, but need much heavier per-request queries; `ahccd-*`, `hurricanes-*`, `hydrometric-*`, `aqhi-*`, `marineweather-*` aren't relevant to structural pole risk.

Every parsed record is validated at runtime before use — a malformed field anywhere in a live API response is skipped (with a logged warning), not allowed to fail the whole request. The live API is never called from the committed test suite (mocked instead, for speed and CI reliability); verified against the real API via manual smoke tests during development.

### Scoring

**`RiskScoringService`** (`src/scoring/`) is a pure function: given the fetched soil profile, climate normals, and current conditions, it computes `longTermRisk`, `shortTermRisk`, and `overallRisk`. See [Scoring formula](#scoring-formula) for the actual math.

### Score cache

**`ScoreCacheRepository`** (`src/score-cache/`) persists one row per exact `(lat, lng)` in a SQLite file, via [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) — synchronous, file-based, no server process to manage, consistent with this project's preference for small direct-SQL repositories over an ORM.

Caching is a specific hybrid, not a plain read-through cache: on a repeat request for a known location, soil and climate-normals lookups are skipped entirely and the stored `longTermRisk` is reused (soil and 30-year normals are genuinely stable), but live current conditions are always fetched fresh and `shortTermRisk` is always recomputed — a repeat query should never return stale wind/temperature data. Cache eligibility depends only on soil and climate normals resolving, independent of whether live current conditions succeeded on that particular request — since `longTermRisk` never needed current conditions in the first place, gating the entire cache on all three would have meant some perfectly cacheable locations could never be cached at all.

DB file defaults to `data/viability-scores.db` (gitignored), overridable via `SCORE_CACHE_DB_PATH`; tests use `:memory:` for isolation.

### API endpoint

**`ViabilityController` + `PoleViabilityService`** (`src/viability/`) tie the above together: fetch soil, climate normals, and current conditions (or reuse the cache), compute the score, persist it, and return only `PoleViabilityScore` — never the raw profiles. Query params are validated with `class-validator` before reaching any service.

## Scoring formula

`RiskScoringService` (`src/scoring/risk-scoring.service.ts`) turns soil, climate-normals, and current-conditions profiles into a **long-term risk** (structural, from soil + 30-year climate normals), a **short-term risk** (from live current conditions), and an **overall risk**, each clamped to `[0, 1]`. Every threshold is a documented, researched estimate — there's no pole-failure data to calibrate against (see [Problem](#problem)) — so this is a defensible first draft, not a validated model. Full reasoning lives in code comments next to each constant; this section is the map.

`dataAvailable` is `false` only when soil or climate-normals data is unavailable for the location — those are what `longTermRisk` needs, and without either there's no meaningful score. If soil and climate succeed but current conditions don't, `dataAvailable` is still `true`: `longTermRisk` is real, `overallRisk` falls back to it alone, and only `shortTermRisk` is `null`.

### Soil code legends

The formula needed the actual meaning of SLC's coded values, pulled from AAFC's per-field legend pages (`sis.agr.gc.ca/cansis/nsdb/soil/v2/snt/*.html`, `.../slc/v3.2/crt/*.html`):
- **Drainage** (best → worst): very rapid, rapid, well, moderately well, imperfect, poor, very poor.
- **Water table**: never present, present (unspecified period), non-growing season, growing season, always present.
- **Kind**: mineral, organic, true non-soil (airport/lake), unclassified.
- **Depth class** (before bedrock/hardpan/water table): <25cm, 25-49cm, 50-74cm, 75-99cm, ≥100cm, or non-applicable (e.g. rock at surface).

### Long-term risk — structural baseline

A weighted combination of six sub-scores (each independently `[0, 1]`), directly implementing the relationships in [Assumptions](#assumptions):

| Sub-score | Weight | Inputs | What it captures |
|---|---|---|---|
| Footing depth | 0.25 | Depth class averaged with bulk-density risk | How deep a footing can go before hitting bedrock/hardpan/water table, **and** how much resistance the soil in that embedment zone actually provides — depth alone only answers the first question. |
| Soil wetness | 0.20 | Drainage + water-table class, amplified by clay % and slope % | Static "how wet does this soil typically get" — amplified because clay is strong dry but weak wet, and slope lets saturated/thawing soil creep. |
| Saturation duration | 0.15 | Precipitation × hydraulic conductivity | Dynamic "how long does it stay wet after rain" — **multiplicative**: heavy rain on fast-draining soil isn't a saturation problem, slow drainage in a dry climate rarely gets saturated. |
| Wind | 0.20 | Mean wind + high-wind-day frequency, amplified by footing depth | Wind loads the pole directly, independent of soil moisture — amplified by footing depth (anchor resistance), not by wetness. |
| Freeze-thaw | 0.20 | Frost-free period + degree-days below 0°C, amplified by soil wetness | Freeze-thaw cycle exposure — amplified by soil wetness, since dry soil freezing doesn't heave much. |
| Organic soil | additive bump | Mineral/organic kind | +0.3 for organic soil (materially worse bearing capacity), +0.1 for unclassified (genuinely unknown, not "safe by default"), 0 for ordinary mineral soil. |

`longTermRisk = clamp01(weighted sum + organic soil bump)`.

Every raw value maps to `[0, 1]` via linear interpolation between two reference points chosen from the realistic Canadian range for that variable (e.g. 200-1200mm/yr precipitation spans dry Prairies to wet coastal BC) — informed estimates, not measured thresholds. Footing depth specifically combines the SLC depth class with soil bulk density (1.6g/cm³ dense → 0 risk, 0.9g/cm³ loose → max risk): depth alone answers how far down a footing can reach, not how much resistance the soil there actually provides, which is what determines real overturning resistance.

### Short-term risk — live modifier

Two sub-scores: **wind anomaly** (the larger of current gust vs. this location's normal wind, and current gust against an absolute storm-force floor — anomaly alone would under-react in an already-windy location, an absolute floor alone would miss a smaller-but-unusual spike), and **freeze-thaw transition** (peaks when current temperature is exactly 0°C, the active freeze-thaw boundary, tapering to 0 by ±5°C, amplified by soil wetness).

`shortTermRisk = clamp01(windAnomalyRisk × 0.6 + freezeThawTransitionRisk × 0.4)`.

There's no live precipitation factor — the current-conditions source has no rain gauge field (see [Architecture](#architecture)); a known gap, not an oversight.

### Combining into overall risk

`overallRisk = clamp01(longTermRisk + shortTermRisk × 0.3)` — **additive**, not a blended average. A blended average would let a calm moment artificially pull down an inherently risky location's score; additive means calm short-term conditions never discount the structural baseline, while genuinely elevated live conditions can meaningfully push the score up on top of it.

### Worked example

Regina, SK — deep, well-drained soil (bulk density 1.2g/cm³), low slope, moderate wind/freeze-thaw normals, calm conditions with a moderate gust: `longTermRisk ≈ 0.24`, `shortTermRisk ≈ 0.16`, `overallRisk ≈ 0.29` — a real but unremarkable risk level, consistent with an ordinary prairie city block.

### Logging

Only `dataAvailable`/`overallRisk`/`shortTermRisk`/`longTermRisk` are returned from the API. Everything else is logged, not returned, so nothing is lost but the response payload stays minimal: `RiskScoringService` logs the full-precision risk numbers plus the entire per-factor breakdown; `PoleViabilityService` logs the raw soil/climate/current-conditions profiles it fetched. Tests for the detailed formula math capture the logged breakdown directly (via a logger spy) rather than asserting on the trimmed public response.

## Assumptions

Neither dataset alone says anything about pole failure — these are our own hypotheses about how the collected factors combine into fall risk, written down so the formula's weights trace back to a stated reason rather than an arbitrary number. Unverified against real outcomes (see [Problem](#problem)); revise freely as research surfaces something better.

- **Rain weakens soil, and how long it stays weak depends on drainage.** Saturated soil loses shear strength — a pole is more likely to lean or fall during or shortly after heavy rain than in dry conditions. Total precipitation is the moisture load; hydraulic conductivity and drainage class describe how fast that moisture drains back out. High precipitation + poor drainage should compound.
- **Cold intensity plus soil moisture drives frost heave.** Freeze-thaw cycling heaves and shifts whatever's anchored in the ground. Degree-days below zero and frost-free period describe how much freezing the ground sees; water table and clay content describe how much water is present to actually freeze and expand — dry, well-drained soil has little to heave even under heavy freezing.
- **Wind loads the pole directly, independent of soil.** This is the one factor that isn't soil-mediated — it combines with the footing's resistance (depth, bearing capacity) rather than with soil-moisture factors.
- **Slope compounds existing risk rather than being independent.** Slope alone doesn't move a vertical pole, but on saturated or freeze-thaw-active soil it enables lateral creep that flat ground wouldn't — a multiplier on other factors, not an additive term of its own.

## Known limitations

Real, documented physical failure mechanisms this formula does not model — recorded here rather than silently absent. None of these are oversights so much as explicit scope calls given what data is actually available (no per-pole data exists — see [Problem](#problem)):

- **Ice/freezing-rain load** — the single biggest gap for a Canada-scoped tool. The January 1998 ice storm, Canada's most significant infrastructure-collapse event on record, felled roughly 30,000 utility poles; iced conductors present far more sail area, so ice load compounds multiplicatively with wind in real failure mechanics. Nothing in this formula accounts for icing.
- **Guy-wire/anchoring** — real distribution poles, especially at corners/dead-ends, often get their primary overturning resistance from guying, not soil alone. This formula has no way to know whether a given pole is guyed, so it can only estimate *unguyed* site risk.
- **Quick/sensitive (Leda) clay landslides** — a real, documented, Canada-specific hazard in the St. Lawrence/Ottawa Valley region (fatal historical events include Notre-Dame-de-la-Salette 1908, St-Jean-Vianney 1971, Lemieux 1993, St-Jude 2010). A distinct, sudden/catastrophic failure mode from the generic slope-creep model this formula represents — can occur on very gentle slopes when the toe is eroded or the clay disturbed.
- **Erosion/scour at the pole base** — proximity to a riverbank or drainage channel isn't captured by any field currently used; undermining is a distinct failure mechanism from the saturation/bearing-capacity pathway already modeled.
- **Permafrost engineering** — for northern locations where the freeze-thaw factors already clamp to maximum risk, real infrastructure typically uses entirely different foundation techniques (piles, thermosyphons), since seasonal freeze-thaw modeling doesn't apply the same way in perennially frozen ground. "Maximum freeze-thaw risk" under this formula is a different physical regime in the true north than in, say, Winnipeg.
- **Wood decay/rot** — worth stating plainly: published estimates attribute roughly 60-85% of *actual* real-world wood pole failures to fungal core rot, not any site/climate/soil mechanism at all. A genuine, deliberate scope boundary (no per-pole age/material/species/inspection data exists to model it against) — this tool estimates *site* risk, not overall failure probability, and the single largest real-world cause of pole failure is structurally outside what it can ever answer.

## Review & validation

This project has been independently reviewed twice: once for the science behind the formula, once for the engineering behind the implementation.

**Domain-science review** (environmental/geotechnical, checked against real literature — utility pole-setting standards, soil physics, Canadian climatology):
- Validated as well-anchored, not just plausible: the wind reference points track real Environment Canada normals closely (Regina/Lethbridge ~18.3-18.4 km/h; St. John's, Canada's windiest city, ~22-24 km/h); the hydraulic-conductivity range matches published soil-physics values for sand vs. clay loam almost exactly; drainage-class-as-strength-proxy is consistent with published shear-strength-vs-saturation research (50-80% strength loss from optimum to saturated).
- Found that soil bulk density was collected and documented as a bearing-capacity proxy but never actually used in the formula — fixed; footing depth risk now combines depth class with bulk density (see [Scoring formula](#scoring-formula)).
- Found that the precipitation and degree-days-below-zero ranges saturate before the true extremes of coastal BC and the far north are reached — acceptable as "risk saturates past a point," but means the formula can't distinguish a cold Prairie city from an Arctic community. Not yet addressed.
- Flagged that soil wetness is currently counted in three places (direct weight, amplifying freeze-thaw risk, amplifying the freeze-thaw transition risk) — may be intentional (wetness genuinely compounds with freezing physically) but wasn't a deliberate weighting decision. Not yet resolved.

**Code review** (full codebase, correctness/concurrency/security/resilience):
- Found that a single malformed record anywhere in a live climate API response (a station outage, an API schema drift) would throw and fail the *entire* request, even for an otherwise-resolvable location — fixed; every parsed record is now validated explicitly and malformed ones are skipped with a logged warning rather than failing the request.
- Found that cache eligibility was gated on soil, climate, *and* current conditions all succeeding, even though the cached value (`longTermRisk`) only ever depended on soil and climate — meaning a location could be permanently uncacheable just because the live-conditions lookup happened to fail once. Fixed; caching now depends only on soil and climate resolving.
- Remaining, not yet addressed: no timeout on outbound calls to the climate API (a stalled upstream connection currently hangs the request rather than failing fast); no de-duplication of concurrent identical cache-miss requests (not a correctness bug — the cache write is idempotent — just duplicate upstream load under concurrent traffic); unbounded cache growth (no TTL/eviction/row cap); the soil "no data" numeric sentinel is applied uniformly to every field, worth spot-checking against AAFC's per-field documentation rather than assumed; no authentication or rate-limiting on the public endpoint (reasonable at this project's current stage, worth revisiting if it's ever exposed beyond a trusted network).

## Open questions

**Formula validation**
- Every weight and threshold is an unvalidated first draft — there's no pole-failure data to calibrate against. Revisit once there's any real signal (even informal — known problem poles, utility incident data) to check outputs against.
- Is soil wetness's three-way counting (direct weight + two amplifications) a deliberate emphasis worth keeping, or accidental overweighting worth dialing back?
- Should the ice/freezing-rain gap be addressed by checking the climate-normals collection for a freezing-rain/glaze element, and if so, does it fold into the wind factor (compounds with wind per real failure mechanics) or become its own factor?
- The restriction-type code legend (bedrock vs. hardpan vs. other causes) exists but isn't used — footing depth currently relies on depth class + bulk density alone. Revisit if the formula ever needs to distinguish an immovable restriction (bedrock) from a softer one.

**Data sources**
- Is live precipitation (a considerably more complex data source) worth the integration effort, or is the climate-normals average sufficient? Its absence is the biggest known gap on the short-term side.
- Should the daily-resolution/extremes climate collections get pulled in later for more precise freeze-thaw-cycle counts and worst-case events, or do the normals-based proxies turn out to be good enough?
- Should soil ingestion move to a real spatial database (e.g. PostGIS) if the dataset grows, or does in-memory-at-startup stay sufficient?

**Product scope**
- Does "city name" input require geocoding to lat/lng first, and via what service?
- Does the formula need to distinguish telephone poles from electrical poles (different material, height, load standards)? Currently one formula for any pole type.

**Operational**
- No cache invalidation strategy (soil data never changes, but are 30-year climate normals ever revised, and would we know?) and no formula-version tracking on cached rows — if the formula changes, old cached values silently keep using whatever formula computed them.
- The engineering-review findings above (fetch timeouts, request coalescing, cache growth bounds, rate limiting) are all real but deferred — appropriate for this project's current research-prototype stage, worth revisiting before any production exposure.

## Development

Standard NestJS project — see `CLAUDE.md` for commands and conventions.

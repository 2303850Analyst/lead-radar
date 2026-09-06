# LeadRadar

Current version: **0.4.0-alpha.1**

LeadRadar is a local MVP for discovering potential B2B customers among
low-visibility and weakly digitized companies. Users describe a target business,
related queries, geography, and their own services; the application returns an
explainable set of organizations.

LeadRadar is a **discovery system, not a complete market registry**. Search
providers return relevant samples and do not guarantee exhaustive coverage.

## Current alpha capabilities

- Russian-language search tasks with primary, related, and excluded queries;
- open-vocabulary interpretation through `SemanticIntentV2`: Kimi identifies the
  goal, core, adjacent, and excluded business types, services, signals, and
  retrieval terms without a fixed niche list;
- strict Structured Output with local validation of size, shape, semantic
  invariants, and a ban on executable URLs, coordinates, and provider parameters;
- interpretation preview and confirmation of ambiguous requests before map access;
- pilot locale/country contracts for RU, BY, and KZ;
- search, table, map, and lead-card views;
- interactive 2GIS MapGL maps for selecting a center and radius and displaying results;
- city, district, metro, region, and manual-radius geography modes;
- metro search for all seven Russian cities with an active metro system;
- server-side city, district, region, and address geocoding;
- filtering, sorting, pagination, and CSV export where licensing permits;
- website links, statuses, notes, and permitted local persistence;
- `GET/POST /api/search`, `POST /api/geocode`, and `GET /api/metro-stations`;
- live NDJSON progress without changing the regular JSON API contract;
- a separate `POST /api/search/plan` that consumes no search-provider quota;
- deterministic demo mode without API keys;
- free-text organization search through 2GIS Places;
- Geoapify Geocoding, Autocomplete, Places, and Place Details support;
- server-side API keys and a separate browser-restricted MapGL key;
- provider metadata, per-card provenance, and mandatory attribution;
- explicit 2GIS, Geoapify, or demo selection without automatic source mixing;
- an experimental Yandex adapter, disabled pending written license confirmation.

## Quick start

Requirements: Node.js `>=22.13.0` and npm.

```powershell
npm install
npm run build
npm run start
```

Open [http://localhost:3000](http://localhost:3000). The server binds to
`127.0.0.1` by default so other LAN devices cannot consume provider quota through
the local API. `npm run dev` remains available for hot reload. On Windows, the
verified MVP path is a production build followed by `npm run start` because the
Cloudflare plugin may terminate inside `workerd` during development.

Without extra configuration, LeadRadar uses synthetic demo data and deterministic
category interpretation. Live Kimi is not required for known taxonomy queries.

### 2GIS configuration

Create `.env.local`:

```env
DGIS_API_KEY=new_2gis_server_key
DGIS_MAP_KEY=separate_browser_2gis_map_tiles_key
DGIS_DEMO_MODE=true
DGIS_MAX_PAGES=20
DGIS_CONTACTS_ENABLED=false
DGIS_EXPORT_ENABLED=false
SEARCH_PROVIDER=2gis
```

2GIS search follows pages up to the reported `total`. A demo key permits up to
five pages of ten cards; production uses pages of 50 and defaults to 20 pages per
phrase. `DGIS_MAX_PAGES` may be raised to 100, with every page consuming one
Places API request.

Before external deployment, revoke any development key that appeared in a chat,
log, or screenshot. See [`docs/2gis-setup.md`](docs/2gis-setup.md) and
[`docs/geoapify-setup.md`](docs/geoapify-setup.md). Restart the server after an
environment change.

### Kimi configuration

Store the Kimi key outside the project in:

```text
C:\Users\<user>\.sa-trainer-secrets\kimi.env
```

```env
KIMI_API_KEY=your_Moonshot_key
```

Run through the wrapper:

```powershell
npm run build
.\scripts\run-with-kimi-secret.ps1 -NpmScript start
```

The wrapper exposes the key only to the child process, enables
`QUERY_INTELLIGENCE_MODE=kimi`, and creates a temporary signing secret when
needed. Override the file path with server-side `KIMI_SECRET_FILE`. Persistent
environments should provide a stable `SEARCH_PLAN_SIGNING_SECRET` of at least 32
bytes through secret storage. Keep `KIMI_LEAD_CLASSIFICATION_ENABLED=false`:
the current alpha evaluates relevance locally and does not send company cards to Kimi.

### Local Docker run

Docker runs the production build at
[http://127.0.0.1:3000](http://127.0.0.1:3000). The container is limited to 0.5
CPU, 256 MB RAM, a 160 MB Node.js heap, and 64 processes; its root filesystem is
read-only. Secrets are supplied only at runtime.

```powershell
$env:KIMI_SECRET_FILE="C:/Users/<user>/.sa-trainer-secrets/kimi.env"
npm run docker:up
docker compose ps
npm run docker:down
Remove-Item Env:KIMI_SECRET_FILE -ErrorAction SilentlyContinue
```

Compose reads the Git-ignored `.env.local` automatically. Without keys, the
service starts in demo/deterministic mode. If live search consistently exits
because of OOM, increase only `mem_limit` in `compose.yaml` to `320m`.

## Verification

```powershell
npm run quality
```

This runs ESLint, strict TypeScript, a production build, automated tests, and
offline evaluation. Regular tests do not call live Kimi.

```powershell
npm run eval:open-world
npm run eval:relevance
```

The first command evaluates 500 frozen CIS intent scenarios through mock Kimi and
the real planner/compiler. The second evaluates 600 labeled synthetic
candidate-evidence scenarios across 150 provider targets through the real
deterministic relevance runtime. Only aggregates, versions, and checksums are
printed; queries, leads, and provider responses are not stored.

Optional live Kimi canary:

```powershell
$env:RUN_KIMI_LIVE_EVAL="1"
.\scripts\run-with-kimi-secret.ps1 -NpmScript eval:kimi:live
Remove-Item Env:RUN_KIMI_LIVE_EVAL
```

It stores only canonical IDs, statuses, latency, and token usage in the ignored
`work/evaluations/` directory. Prompts, keys, reasoning, and cards are not persisted.

End-to-end search canary:

```powershell
$env:RUN_SEARCH_LIVE_CANARY="1"
npm run canary:search:live
Remove-Item Env:RUN_SEARCH_LIVE_CANARY
```

This canary consumes Kimi and Geoapify quota and requires `GEOAPIFY_API_KEY`.
Category hints are enabled only inside the canary; production keeps
`GEOAPIFY_CATEGORY_HINTS_ENABLED=false`. Full intents, positions, company cards,
and session-salted identities stay in memory. The aggregate reports
`attainable@10`, conditional ranker recall, provider-arm counters, Details, and
category resolution. These metrics cover executed retrieval arms rather than the
whole market. Published results are in
[`docs/evaluations/v0.4.0-alpha.1-search-live-canary.md`](docs/evaluations/v0.4.0-alpha.1-search-live-canary.md).

## API

### `GET /api/search`

Returns health, version, active mode, and safe provider configuration flags. It
never returns keys, keyed upstream URLs, or complete provider responses.
`SEARCH_PROVIDER` selects `2gis`, `geoapify`, or explicit synthetic `demo` mode.

```json
{
  "status": "ok",
  "service": "LeadRadar Search API",
  "version": "0.4.0-alpha.1",
  "mode": "2gis",
  "searchProvider": "2gis",
  "dgisConfigured": true,
  "dgisKeyConfigured": true,
  "capabilities": {
    "queryIntelligence": {
      "configured": true,
      "mode": "kimi",
      "model": "kimi-k3",
      "strictStructuredOutput": true
    },
    "twoGisPlaces": {
      "configured": true,
      "freeTextSearch": true,
      "providerCategoryIdRequired": false,
      "strictRadius": true,
      "maxResultsPerPage": 10,
      "geocodingSource": "2GIS Geocoder API",
      "rawResponsesStored": false
    }
  }
}
```

### `POST /api/geocode`

Resolves a city, district, or address through 2GIS Geocoder or Geoapify
Geocoding, according to `SEARCH_PROVIDER`. The key remains server-side.

```json
{ "location": "Moscow, 7 Lesnaya Street" }
```

A successful response contains `coordinates` in `[longitude, latitude]` order,
the original `location`, and `provider`.

### `GET /api/metro-stations`

Returns normalized stations for `moscow`, `saint-petersburg`, `novosibirsk`,
`nizhny-novgorod`, `samara`, `yekaterinburg`, or `kazan`.

```text
GET /api/metro-stations?city=moscow
GET /api/metro-stations?city=samara&q=Gagarinskaya
```

2GIS mode uses Places with `type=station.metro`; Geoapify mode uses Places →
Geocoding → Place Details. Responses contain normalized names, coordinates, line
colors, and provider IDs, never keys or complete upstream responses. The catalog
is cached in process for 24 hours. Refinement requires two characters and has a
30-second total deadline. Selected stations are revalidated with the provider.

### `POST /api/search/plan`

Interprets a request without calling a search provider:

```json
{
  "description": "A place where men get haircuts",
  "primaryQuery": "men's haircut",
  "relatedQueries": [],
  "excludeQueries": ["pet grooming"],
  "locale": "ru-RU",
  "countryCodes": ["RU"]
}
```

It returns `SearchPlan` version `2.2` with status `ready`, `needs_confirmation`,
`unsupported`, or `degraded`; `semanticIntent`; separate meaning and provider
coverage confidence; versions, usage, latency, and hashes. Legacy canonical IDs
may appear in `resolution.selectedConceptIds`; the server derives them after Kimi
and never sends them to the model. `needs_confirmation` is HTTP 200 and prevents
map search until confirmed.

### `POST /api/search`

`primaryQuery` is required. Geography is supplied through `location` or `center`;
the default radius is 15 km.

```json
{
  "description": "Companies providing fulfillment services",
  "primaryQuery": "Fulfillment",
  "relatedQueries": ["Warehousing", "Storage services", "Order picking"],
  "excludeQueries": ["Luggage storage", "Garage rental"],
  "location": "Moscow",
  "center": [37.6173, 55.7558],
  "radiusKm": 15,
  "offer": "Digitizing request processing and implementing CRM",
  "services": ["Website development", "CRM", "Automation"],
  "locale": "ru-RU",
  "countryCodes": ["RU"]
}
```

When `center` is present, no repeated geocoding occurs. The response contains
request parameters, provider metadata, summary, `leads`, and explicit `outcome`.
Non-empty output is `success_with_results`; empty provider output is
`success_empty` with HTTP 200. Lead requirements use `confirmed_match`,
`confirmed_mismatch`, `unknown`, or `conflicting`; missing data is `unknown`, not
a match. Ambiguity returns HTTP 409 `clarification_required`. Validation and
infrastructure failures use `technical_failure`; live provider failures are not
replaced by demo data. An unambiguous physical intent without a local concept ID
does not receive terminal 422: a bounded fallback plan is compiled.

### `POST /api/search?stream=1`

Returns `application/x-ndjson` events for validation, intent resolution,
geocoding, provider compilation, places, relevance, details, normalization, and
completion. The final line contains either a result or one structured error. The
local Tier-0 profile has a 60-second end-to-end deadline and emits a heartbeat at
least every two seconds. Client disconnect cancels all remaining work. Optional
stages that cannot fit the budget are listed in `provider.coverage.degradedStages`.

```powershell
npm run smoke:stream
```

## Live 2GIS search

LeadRadar sends free-text business type, center, and radius to 2GIS Places. A
known `rubric_id` is unnecessary. The server runs up to three bounded searches
for the core type and synonyms, then deduplicates and evaluates relevance locally.
Empty output is `success_empty`.

2GIS is selected explicitly and is not mixed with Geoapify in one result set.
Both embedded maps use 2GIS MapGL. Production should use a separate
domain-restricted `DGIS_MAP_KEY`. Falling back to `DGIS_API_KEY` exposes that key
to the browser and is intended only for local verification.

2GIS demo results use `contract_required`: attribution is displayed, but records
are not stored in `localStorage`. `DGIS_EXPORT_ENABLED=true` permits normalized
CSV only when contractual rights are confirmed and never stores raw responses.
An API key or personal research purpose alone does not establish those rights.

## Live Geoapify search

Geoapify remains a separate provider. Its bounded chain is category Places →
Autocomplete for unknown categories → Forward Geocoding with the original
business type when category resolution fails or Places yields no relevant cards.
Radius is not increased. Unrecoverable timeouts, `429`, and `5xx` become provider
errors and are not replaced with demo data. Cross-provider failover is absent.

The free plan requires visible Geoapify and OpenStreetMap attribution. Replace
any test key exposed outside server-side storage before deployment.

## Query Intelligence and Kimi

Kimi receives only normalized user category, locale, and country fields—not
canonical candidates, company cards, contacts, coordinates, or provider
categories. It returns open-vocabulary `SemanticIntentV2`; the server validates
its strict schema and prevents executable model output.

Provider-neutral English terms are mapped to a pinned catalog of 813 Geoapify
categories. The compiler creates up to four retrieval arms: exact, broad,
adjacent, and safe name search, with at most four provider calls and 200 observed
cards. Category arms use Places; unresolved name arms use bounded Forward
Geocoding. Model text never becomes an unchecked provider category.

A recovery arm may use Places only after Autocomplete confirms an allowlisted
leaf with at least two distinct in-country, in-radius observations. No match
falls back to text geocoding. Broad categories are not evidence by themselves.
Category IDs are revalidated before provider calls; the old 40-niche dictionary
exists only for backward compatibility.

The compiler accepts exact normalized registry matches, never partial word
overlap. Name fallback uses the user's language and is skipped after at least ten
`matched + maybe` results. Provider-native hints are optional, cannot modify the
signed plan, and are disabled by default.

Cards are deduplicated before Details and retain all discovery reasons.
Exclusions are applied to name, provider categories, and short description before
Details quota is spent. The UI recommends `matched + maybe` by default while
keeping `rejected` and `not_checked` accessible.

Issue #11 currently has a `FAIL` quality decision: fixed-k Precision@10 and
encoder p95 targets were not met. This is not an external SLA claim.

## Experimental Yandex API

The Yandex adapter is disabled by default. Without written permission, do not
persist, score, export, or display its responses on third-party maps. See
[`docs/yandex-live-test.md`](docs/yandex-live-test.md).

## Limitations

- Production release `v0.4.0` remains `NO-GO`.
- Frozen planner evaluation reached 500/500 CIS intents and deterministic
  relevance reached 600/600 synthetic cards, but neither proves live-model quality.
- The optional Kimi lead classifier is disabled and company cards are not sent to it.
- RU is supported; BY and KZ are pilots; other CIS countries are unsupported.
- Scheduling, admission control, circuit breaking, and deadlines are process-local.
  There is no authentication, distributed limiter, multi-tenancy, or coordination.
- The production canary passed safety/contract gates but achieved Precision@10
  `0.7500` against `0.85` and encoder p95 29.073 seconds against 20 seconds.
- Provider separation is partial; geocoding and enrichment are not yet isolated
  into a two-phase search service.
- Up to eight search terms are allowed per task.
- Radius is 0.5–250 km; arbitrary polygons are unavailable.
- City, district, and region use circular coverage, not administrative boundaries.
- Metro data is provider-derived and is not an official registry.
- Geoapify Places is not an exhaustive full-text business registry.
- Contact and website completeness depends on source data.
- Automatic multi-provider fallback and aggregation are not implemented.
- Missing URLs mean only that the source did not provide one.
- Websites and social networks are not verified in live mode.
- Scoring is heuristic, not a sales-conversion forecast.
- Persistence, enrichment, export, and CRM require appropriate source licenses.

## Project documentation

- [`ROADMAP.md`](ROADMAP.md) — development stages and readiness criteria.
- [`changes_log.md`](changes_log.md) — material business-logic decisions.
- [`docs/2gis-setup.md`](docs/2gis-setup.md) — keys, policy, and 2GIS verification.
- [`docs/geoapify-setup.md`](docs/geoapify-setup.md) — setup and Geoapify fallback.
- [`docs/yandex-live-test.md`](docs/yandex-live-test.md) — isolated adapter test.
- [`docs/semantic-query-planner-architecture.md`](docs/semantic-query-planner-architecture.md)
  — AI boundaries, SearchPlan, SLO hypotheses, and target architecture.
- [`docs/v0.4.0-query-intelligence-spec.md`](docs/v0.4.0-query-intelligence-spec.md)
  — executable specification and quality gates.
- [`docs/evaluations/v0.4.0-alpha.1-query-intelligence.md`](docs/evaluations/v0.4.0-alpha.1-query-intelligence.md)
  — anonymized initial evaluation and production `NO-GO` decision.
- [`docs/evaluations/v0.4.0-alpha.1-search-live-canary.md`](docs/evaluations/v0.4.0-alpha.1-search-live-canary.md)
  — aggregate production-orchestrator canary and quality-gate `FAIL`.
- [`AGENTS.md`](AGENTS.md) — permanent versioning and release rules.

This README is a stable product and operations document, not a chronological log.
History belongs in `changes_log.md`.

## Versioning

- `package.json` is the canonical version source.
- Releases use Semantic Versioning and annotated `vX.Y.Z` tags.
- Alpha versions remain untagged until production quality gates return `GO`.
- PATCH fixes behavior without changing business rules.
- MINOR adds a compatible capability or changes product logic.
- MAJOR introduces an incompatible contract, data-model, or workflow change.

## Official resources

- [2GIS Places API](https://docs.2gis.com/en/api/search/places/overview)
- [2GIS Platform Manager pricing](https://docs.2gis.com/en/platform-manager/subscription/pricing)
- [Geoapify Places API](https://apidocs.geoapify.com/docs/places/)
- [Geoapify Pricing](https://www.geoapify.com/pricing/)
- [Geoapify Terms and Conditions](https://www.geoapify.com/terms-and-conditions/)
- [Kimi API models](https://platform.kimi.ai/docs/models)
- [Kimi Chat API](https://platform.kimi.ai/docs/api/chat)
- [Kimi Structured Output](https://platform.kimi.ai/docs/guide/response_format)
- [Kimi rate limits](https://platform.kimi.ai/docs/pricing/limits)
- [Yandex Organization Search API](https://yandex.ru/maps-api/docs/geosearch-api/index.html)
- [Yandex request format](https://yandex.ru/maps-api/docs/geosearch-api/request.html)
- [Yandex response format](https://yandex.ru/maps-api/docs/geosearch-api/response.html)
- [Yandex product page](https://yandex.ru/maps-api/products/geosearch-api)
- [Yandex commercial documentation](https://yandex.ru/dev/commercial/doc/ru/concepts/geosearch)
- [Yandex terms of use](https://yandex.ru/legal/maps_api/ru/)

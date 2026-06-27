# Phase 1 Spec — woldt-federal-solutions: SAM.gov Opportunity Ingestion

**Goal:** Automatically pull federal contract opportunities from SAM.gov into the
`opportunities` table on a schedule, deduplicated and mapped to our schema, so the
opportunity feed is always current with zero manual entry.

**Status:** buildable the moment a SAM.gov (data.gov) API key is provided.
**Estimate:** ~8 hrs (ingestion + mapping + dedupe + schedule + tests).

---

## 1. Architecture
A **Supabase Edge Function** `samgov-ingest` invoked on a schedule (Supabase cron, or
an external scheduler hitting its URL). It calls the SAM.gov Opportunities API, maps
each notice to an `opportunities` row, and upserts on `notice_id`.

```
cron (e.g. every 6h)
   └─> edge fn `samgov-ingest`
         ├─ GET api.sam.gov/opportunities/v2/search  (paged)
         ├─ map each notice -> opportunities row
         └─ upsert on notice_id (service_role) -> public.opportunities
```

Runs with the **service_role** key (bypasses RLS — correct for a backend writer).

## 2. Configuration (env / function secrets)
| Var | Purpose |
|---|---|
| `SAM_API_KEY` | data.gov API key for api.sam.gov |
| `SUPABASE_URL` | project URL (`https://yivzkppqnclhfyjixzkh.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | writer key (server-side only, never client) |
| `SAM_NAICS` | comma-list of NAICS codes to track (filter) |
| `SAM_POSTED_FROM_DAYS` | lookback window, default `7` |
| `SAM_PTYPE` | notice types to include, e.g. `o,p,k` (solicitation/presol/combined) |

## 3. Source API
`GET https://api.sam.gov/opportunities/v2/search`
Key query params: `api_key`, `postedFrom`/`postedTo` (MM/dd/yyyy), `ptype`,
`ncode` (NAICS), `limit` (≤1000), `offset`. Page until `totalRecords` consumed.

## 4. Field mapping → `public.opportunities`
| Column | Source (SAM.gov notice) | Notes |
|---|---|---|
| `notice_id` | `noticeId` | **conflict key** for upsert |
| `source` | const `'sam.gov'` | |
| `solicitation_number` | `solicitationNumber` | |
| `title` | `title` | |
| `agency_path` | `fullParentPathName` | hierarchy string |
| `notice_type` | `type` | |
| `base_type` | `baseType` | |
| `naics` | `naicsCode` | |
| `classification_code` | `classificationCode` | |
| `set_aside` | `typeOfSetAside` | |
| `set_aside_code` | `typeOfSetAsideDescription`/code | |
| `posted_date` | `postedDate` | date |
| `response_deadline` | `responseDeadLine` | timestamptz; set `response_deadline_tz_present` if offset present |
| `place_of_performance` | `placeOfPerformance` (flatten) | text summary |
| `active` | `active` ("Yes"/"No") → bool | |
| `description_link` | `description` (URL) | SAM returns a link to fetch full text |
| `ui_link` | `uiLink` | |
| `points_of_contact` | `pointOfContact[]` | store as `jsonb` |
| `raw` | entire notice object | `jsonb` — preserve everything for later phases |

## 5. Idempotency / dedupe
Upsert: `insert ... on conflict (notice_id) do update set ...`. Re-running the job is
safe; existing rows refresh (e.g. `active` flips to false when an opp closes).

## 6. Error handling
- Per-page try/catch; a failed page is retried (backoff) then skipped with a logged count — one bad page never aborts the run.
- Non-200 from SAM.gov → log status + body, exit non-fatally (next cron retries).
- Partial-batch insert failures logged with `notice_id`s; never silently dropped.

## 7. Acceptance criteria
1. Given a valid `SAM_API_KEY`, a run populates `opportunities` with the last `SAM_POSTED_FROM_DAYS` of matching notices.
2. Re-running produces **no duplicates** (row count stable; `updated`-style refresh only).
3. `raw` holds the full source object for every row.
4. A closed opportunity shows `active = false` after the next run.
5. Function completes within timeout for ≥1000 notices (paging works).

## 8. Test plan
- Unit: field-mapper against 3 sample SAM.gov payloads (solicitation, presol, award-ish) — including missing optional fields.
- Integration: dry-run mode (`?dryRun=1`) that maps + counts but does not write.
- Live smoke: one real paged run against a narrow NAICS + 2-day window; verify counts and a spot-checked row.

## 9. Out of scope (later phases)
Fetching/parsing the full solicitation PDF (Phase 2), requirements shredding,
capture profiles, ranking/scoring. Phase 1 only fills the opportunity feed.

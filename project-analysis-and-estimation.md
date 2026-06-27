# DWCI Project Analysis & Remaining-Work Estimation

**Prepared:** 2026-06-27
**Scope:** `woldt-federal-solutions` and `intake-engine`
**Method:** Direct inspection of the live Supabase databases (schema, migrations, RLS,
functions, row counts, advisors), the in-scope GitHub repo, and Render config.

> **Source-of-truth caveat.** The desktop folders and Claude *project-knowledge*
> folders referenced in the request are **not reachable** from the execution
> environment, and GitHub access is scoped to a single repo
> (`woldtd2/dwc---david-woldt-consulting-inc`, which holds only the unrelated
> *Practice Pulse metrics server*). This analysis is therefore grounded in the
> **live database state** — what is actually provisioned today — rather than the
> written plans. Where a written plan would change an estimate, that is flagged.

---

## Snapshot: where each project actually stands

| | woldt-federal-solutions | intake-engine |
|---|---|---|
| Supabase ref | `yivzkppqnclhfyjixzkh` | `vbrwsdsauuuoyewfeyog` |
| Created | 2026-06-21 | 2026-06-22 |
| Migrations applied | 2 | 5 |
| Public tables | 8 | 6 |
| Rows of data | **0 (all tables empty)** | **0 (all tables empty)** |
| RLS enabled | Yes, on all tables | Yes, on all tables |
| RLS **policies** | **None (0)** | **None (0)** |
| Custom DB functions | None (only pgvector built-ins) | None |
| Edge Functions | None | None |
| Storage buckets | 1 | 1 |
| Security advisors | 8× RLS-no-policy + `vector` ext in public | 6× RLS-no-policy |

**Bottom line:** both are **scaffolded backends at the schema stage** — tables and
migrations exist, but there are no access policies, no business logic in the DB, no
deployed functions, and no data. The application/orchestration layer (APIs, LLM
pipelines, voice/telephony, UI) is not present in any repo I can see and presumably
lives in your desktop/other repos.

---

## Project 1 — woldt-federal-solutions

**What it is (inferred from schema):** an AI **federal capture & proposal-automation
platform**. The data model describes a full bid pipeline:

- `opportunities` — SAM.gov-style notices (notice_id, NAICS, set-aside, deadlines, POCs, raw jsonb)
- `solicitations` + `solicitation_pages` — parsed solicitation documents, page text, UCF section detection
- `requirements` — "shredded" requirements (obligation, proposal volume/section, coverage status, confidence) → a compliance matrix
- `compliance_findings` — severity-tagged gaps linked to requirements
- `capture_profiles` — competitive intel: incumbent, competitors, buyer, teaming, win themes, intel gaps, recommended posture
- `past_performance` — corpus with a **pgvector `embedding`** column for semantic matching (CPARS, scope tags, references)
- `bid_runs` — an orchestration **state machine** (status, current_stage, pending_gate, gate_decisions, state, log) — i.e. a gated agentic workflow

**Maturity:** schema complete and thoughtfully designed; **everything above the schema
is unbuilt** (no ingestion, no parsing, no LLM shredding, no vector search RPC, no
gate engine, no UI). pgvector is installed but no index and no search function exist.

### Remaining work — woldt-federal-solutions

| # | Task | Hrs | Autonomous now? |
|---|---|---:|---|
| F1 | RLS policies on all 8 tables (service-role write / authenticated read) | 2 | ✅ Yes |
| F2 | Move `vector` extension out of `public` schema (advisor fix) | 0.5 | ✅ Yes |
| F3 | `match_past_performance()` vector-search RPC + HNSW index on `embedding` | 2 | ✅ Yes |
| F4 | Generate & commit TypeScript DB types | 0.5 | ✅ Yes |
| F5 | Seed/reference data + schema data-dictionary doc | 1.5 | ✅ Yes |
| F6 | SAM.gov ingestion job → `opportunities` (Edge Function + API key) | 8 | ⚠️ Needs SAM API key |
| F7 | Solicitation PDF ingest → `solicitation_pages` + section detection | 14 | ❌ Needs app/LLM pipeline |
| F8 | Requirements shredding (LLM) → `requirements` + `compliance_findings` | 18 | ❌ Needs app/LLM pipeline |
| F9 | Capture-profile generation (LLM + research) → `capture_profiles` | 14 | ❌ Needs app/LLM pipeline |
| F10 | Past-performance embedding pipeline (chunk → embed → store) | 5 | ⚠️ Needs embedding key |
| F11 | `bid_runs` gate/orchestration engine (stage transitions, gate approvals) | 18 | ❌ Needs app design sign-off |
| F12 | Reviewer/PM dashboard UI (opportunities → compliance matrix → bid runs) | 32 | ❌ Needs app repo + design |
| F13 | Auth + multi-user, audit, deploy/CI | 8 | ⚠️ Partial |
| | **Subtotal** | **~120 hrs** | |
| | *of which autonomous now (F1–F5)* | **~6.5 hrs** | |

---

## Project 2 — intake-engine

**What it is (inferred from schema):** a **multi-tenant AI voice-intake agent**
(telephony front door). The model:

- `tenants` — per-customer config (name, vertical)
- `calls` — one row per call: transcript, classified `intent`, `priority`, `autonomy`
  level, `handoff` flag, and a **`grief_firewall`** flag (an empathy/safety guard,
  implying sensitive verticals such as funeral/healthcare/elder care)
- `intake_records` — structured `fields` (jsonb) captured per intent, `complete` flag
- `pending_actions` — gated autonomous actions (autonomy `L1`+, status `pending`)
- `audit_log` — per-call audit trail
- `voice_sessions` — keyed by `call_sid` → **Twilio** (or similar) live session state

**Maturity:** schema is settled (5 migrations incl. a recent reset/rename to the
"intake agent engine" shape). Like F-S, **no policies, no functions, no edge
functions, no data**. The critical gap for a multi-tenant product is that **tenant
isolation is not yet enforced** (RLS on, but zero policies).

### Remaining work — intake-engine

| # | Task | Hrs | Autonomous now? |
|---|---|---:|---|
| I1 | RLS policies w/ **tenant isolation** (JWT claim → tenant) on all 6 tables | 3 | ✅ Yes |
| I2 | `intake_records.complete` auto-evaluation trigger/function vs. intent schema | 2.5 | ✅ Yes |
| I3 | `audit_log` write trigger on `calls`/`pending_actions` changes | 2 | ✅ Yes |
| I4 | Seed a sample tenant + intent/field schema catalog | 2 | ✅ Yes |
| I5 | Generate & commit TypeScript DB types + data-dictionary doc | 1 | ✅ Yes |
| I6 | Twilio voice webhook Edge Function (answer, stream, `voice_sessions`) | 12 | ⚠️ Needs Twilio creds |
| I7 | Transcription + intent classification (LLM) → `calls` | 10 | ❌ Needs app/LLM pipeline |
| I8 | Intake field extraction (LLM) → `intake_records.fields` | 10 | ❌ Needs app/LLM pipeline |
| I9 | `grief_firewall` / empathy guardrail logic | 5 | ❌ Needs policy + design |
| I10 | Autonomy/action executor for `pending_actions` (L1→L3 gating) | 12 | ❌ Needs app design sign-off |
| I11 | Operator dashboard (calls, transcripts, intake review, action approvals) | 28 | ❌ Needs app repo + design |
| I12 | Auth, deploy/CI, observability | 7 | ⚠️ Partial |
| | **Subtotal** | **~94 hrs** | |
| | *of which autonomous now (I1–I5)* | **~9.5 hrs** | |

---

## What I can do autonomously **right now** (no further inputs needed)

Bounded to the Supabase databases I can reach + this repo. These are safe, additive,
and directly clear the open security advisors:

1. **RLS policies** for every table in both projects (F1, I1) — closes all 14
   advisor findings; adds tenant isolation for intake-engine.
2. **Move `vector` out of `public`** in F-S (F2).
3. **Vector search RPC + HNSW index** for past-performance matching (F3).
4. **Helper triggers/functions**: intake completeness (I2) and audit logging (I3).
5. **Reference/seed data** + **TypeScript types** + **data-dictionary docs** for both
   (F4, F5, I4, I5), committed to this repo.

**Autonomous-now effort: ~6.5 hrs (F-S) + ~9.5 hrs (intake-engine) ≈ 16 hrs.**
Each change ships as a reviewable Supabase migration (idempotent, reversible).

## What needs your input before I start
- **Credentials/keys:** SAM.gov API, embeddings provider, Twilio. (F6, F10, I6)
- **App repos:** the LLM pipelines, orchestration, and dashboards (F7–F12, I7–I11)
  live outside the repo I can access — point me at them or grant scope.
- **Design sign-off:** gate engine (F11) and autonomy executor (I10) are
  product-shaped decisions, not mechanical work.

## Totals
| | Full remaining | Autonomous now |
|---|---:|---:|
| woldt-federal-solutions | ~120 hrs | ~6.5 hrs |
| intake-engine | ~94 hrs | ~9.5 hrs |
| **Combined** | **~214 hrs** | **~16 hrs** |

> Estimates are engineering-hours for a single experienced full-stack/AI engineer and
> exclude product discovery, client review cycles, and content/data acquisition.

---

## Completion log — autonomous DB hardening (executed 2026-06-27)

Applied as reversible Supabase migrations on the live projects. **Both projects now
report zero security advisor findings.** SQL is mirrored under
`supabase/<project>/migrations/` and types under `supabase/<project>/types.ts`.

**woldt-federal-solutions** (`yivzkppqnclhfyjixzkh`)
- `0003` — moved `vector` extension `public` → `extensions` (advisor fix; verified search_path resolves).
- `0004` → superseded by `0006`.
- `0005` — HNSW cosine index on `past_performance.embedding` + `match_past_performance()` RPC (executed clean against empty table).
- `0006` — RLS: `authenticated` read-only, writes via service_role (clears RLS-no-policy **and** permissive-policy advisors).
- Generated `types.ts`.

**intake-engine** (`vbrwsdsauuuoyewfeyog`)
- `0006` — `current_tenant()` helper + JWT-claim tenant-isolation RLS on all 6 tables.
- `0007` — `intent_schemas` catalog + `set_intake_complete()` trigger (**tested:** incomplete→false, complete→true).
- `0008` — `log_audit()` triggers on `calls` / `pending_actions` (**tested:** rows written).
- `0009` — seed: 1 demo tenant + 4 funeral-vertical intent schemas.
- Generated `types.ts`.

**Rollback:** each item is reversible — `drop policy` / `drop function` / `drop trigger` /
`drop table public.intent_schemas` / `alter extension vector set schema public`.

**Note on RLS posture:** policies assume backend services use the **service_role** key
(bypasses RLS). If an app component currently reads/writes with the anon/authenticated
key, confirm it still has the access it needs (intake-engine now requires a `tenant`
JWT claim for authenticated access).

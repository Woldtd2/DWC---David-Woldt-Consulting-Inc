# Phase 1 Spec — intake-engine: Twilio Voice Webhook

**Goal:** Answer inbound phone calls via Twilio, identify which tenant was dialed,
create the `calls` + `voice_sessions` records, and return a basic spoken greeting —
the foundation every later phase (transcription, intent, intake) builds on.

**Status:** buildable the moment Twilio credentials + a phone number are provided.
**Estimate:** ~12 hrs (webhook + signature validation + tenant routing + session
records + TwiML + tests).

---

## 1. Architecture
A **Supabase Edge Function** `voice-inbound` set as the Twilio number's **Voice webhook**.
Twilio POSTs call events; the function validates the signature, resolves the tenant
from the dialed number, writes records (service_role), and returns **TwiML**.

```
Caller dials tenant's Twilio number
   └─> Twilio POST -> edge fn `voice-inbound`
         ├─ validate X-Twilio-Signature
         ├─ resolve tenant by dialed `To` number
         ├─ upsert voice_sessions (call_sid) + insert calls row
         └─ return TwiML <Say> greeting (+ <Gather>/<Stream> hook for Phase 2)
```

Runs with **service_role** (bypasses tenant-isolation RLS — correct for the backend).

## 2. Configuration (function secrets)
| Var | Purpose |
|---|---|
| `TWILIO_AUTH_TOKEN` | validate `X-Twilio-Signature` on every request |
| `SUPABASE_URL` | `https://vbrwsdsauuuoyewfeyog.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | writer key (server-side only) |
| `PUBLIC_FN_URL` | this function's public URL (used in signature check + TwiML callbacks) |

## 3. Tenant routing (one small schema add)
Calls must map to a tenant by the **dialed number** (`To`). Add a phone mapping:
```sql
alter table public.tenants add column if not exists phone_number text unique;
-- seed: update tenants set phone_number = '+1XXXXXXXXXX' where name = 'demo-funeral-home';
```
Lookup: `select id, name, vertical from tenants where phone_number = :To`.
If no match → return a generic TwiML greeting and log an `unrouted_call` (don't crash).

## 4. Request handling
- **Method:** POST, `application/x-www-form-urlencoded` (Twilio form params).
- **Validate** `X-Twilio-Signature` using `TWILIO_AUTH_TOKEN` + full URL + sorted params; reject 403 on mismatch.
- Key params used: `CallSid`, `From`, `To`, `CallStatus`, `Direction`.

## 5. Data writes
**`voice_sessions`** (keyed by `call_sid`) — live session state:
```json
{ "tenant": "demo-funeral-home", "from": "+1...", "to": "+1...",
  "status": "in-progress", "started_at": "<ts>" }
```
upsert on `call_sid`; **stamp `data.tenant`** so the tenant-isolation RLS policy works.

**`calls`** — one row per call: `tenant` (name), `vertical` (from tenant),
`transcript` (null in Phase 1), `intent`/`priority`/`autonomy` (null until Phase 2).

## 6. Response (TwiML)
Phase 1 returns a minimal greeting and leaves the hook for Phase 2's media stream:
```xml
<Response>
  <Say voice="Polly.Joanna">Thank you for calling. How can I help you today?</Say>
  <!-- Phase 2: <Connect><Stream url="wss://.../media"/></Connect> or <Gather> -->
</Response>
```
Vertical-aware greeting text (e.g. softer copy when `vertical = 'funeral'`).

## 7. Call lifecycle
Set Twilio **statusCallback** to the same function; on `completed`, update
`voice_sessions.data.status = 'completed'` and stamp end time. (The `0008` audit
trigger already logs the `calls` insert.)

## 8. Acceptance criteria
1. A real inbound call to the tenant's number returns the greeting and the caller hears it.
2. Exactly one `calls` row and one `voice_sessions` row are created, both tenant-stamped.
3. Requests with a bad/missing `X-Twilio-Signature` are rejected (403).
4. A call to an unmapped number gets a generic greeting and is logged, not errored.
5. On hangup, the session status flips to `completed`.

## 9. Test plan
- Unit: signature validator (valid/invalid), tenant resolver (hit/miss), TwiML builder per vertical.
- Integration: replay captured Twilio POST bodies against the function; assert DB rows + TwiML.
- Live smoke: place a real call to a test number; verify audio + both records + completion update.

## 10. Out of scope (later phases)
Real-time media streaming, transcription, intent classification, intake field
extraction, grief_firewall, and autonomous actions. Phase 1 only answers the call and
records the session.

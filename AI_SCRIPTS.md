# AI Script Generation — Cold Start & Warm Learning

## What this adds
`GET /api/generate-scripts?site=<site>&days=<N>` — generates 3 NEW, distinct video
ad scripts using Claude, instead of the single templated script from `/api/script`.

It has two modes, chosen automatically from measured history:

- **Cold start** (fewer than 3 measured bets, or under 5 total measured signups):
  The AI proposes fresh scripts from the *attribution insight alone* (best source,
  its conversion rate, best landing page). It explicitly does NOT claim to have
  learned anything yet — the summary says these are hypotheses to test.

- **Warm** (>= 3 past bets AND >= 5 signups across them): The AI additionally
  conditions on (a) the TEXT of past approved scripts + how many signups each drove,
  and (b) source/landing/campaign aggregates. It returns a transparent, **audience-level**
  research summary describing which script *traits* correlate with signups and why —
  with an explicit low-confidence caveat tied to sample size. It never profiles
  individuals and never reuses past scripts verbatim.

## Guardrails baked in
- **Audience/segment level only.** The prompt forbids inferring any identifiable
  individual's identity or personality. Reasoning is about channels and audiences.
- **Honest about sample size.** Warm mode is gated behind thresholds and the summary
  must flag low confidence; cold start refuses to pretend it has learned anything.
- **No silent failure.** If `ANTHROPIC_API_KEY` is unset, the endpoint returns a clear
  503 (`ai_unavailable`) and points to the still-working template endpoint. API errors
  are caught and returned as `ai_error`, never crashing the server.

## Requirements
Set `ANTHROPIC_API_KEY` in the server environment:
```
ANTHROPIC_API_KEY=sk-ant-... node server.js
```
Without it, everything else in Loop still works; only AI generation is disabled.

## Persistence change (also fixes an old gap)
Approvals now persist to a new SQLite `bets` table (previously in-memory, lost on
restart). Each approved script is stored with its source/landing/campaign/angle and
full text — this IS the memory the warm loop learns from. Signup results are always
recomputed live from the events table (never stored stale) via `GET /api/bets?site=<site>`.

## Endpoints touched/added
- `GET  /api/generate-scripts` — NEW, AI-powered, cold/warm.
- `POST /api/approve` — now persists full script to `bets` (was in-memory).
- `GET  /api/bets` — NEW, lists past bets with live measured signup counts.
- `GET  /api/script` — unchanged, template-based, works with no API key.

## Verification status (honest)
Tested and working: bets persistence, campaign auto-numbering, live result
recomputation, the no-key 503 path, insufficient-data guard, cold/warm branching,
prompt construction, and JSON parsing with code-fence stripping. A real successful
Claude round-trip was not executed in the build sandbox because it lacked a valid
billing key (the call correctly surfaced a 401 as a handled error). Run locally with
your own key to exercise live generation.

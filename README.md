<<<<<<< HEAD
# Loop — v1 (complete)

Closed-loop marketing engine for solo SaaS founders. All five stages work end to end,
in the API **and** in the dashboard:

**Sense** (track) → **Decide** (recommend) → **Create** (generate scripts) → **Approve** (founder reviews) → **Measure** (7-day UTM attribution) → feeds back into Create.

## What's in the box

| Piece | Where | Notes |
|---|---|---|
| Tracking snippet | `snippet/loop.js` | first-touch + last-touch attribution, anonymous visitor id, `loop.track('signup')`, no PII |
| Ingestion + storage | `server/server.js` → `POST /collect` | Express + built-in `node:sqlite`, zero native deps |
| Insights | `GET /api/insights` | per-source visitors / signups / conversion, anomaly flags |
| Recommendation | `GET /api/recommendation` | deterministic, evidence-weighted, refuses thin data |
| **AI script generation** | `GET /api/generate-scripts` | 3 new scripts per call; cold-start vs warm learning (see `AI_SCRIPTS.md`); needs `ANTHROPIC_API_KEY` |
| Template script (fallback) | `GET /api/script` | works with no API key; dashboard falls back to it automatically |
| Approve | `POST /api/approve` | persists full script to the `bets` table (survives restart), auto-numbers campaigns |
| Bet history + live results | `GET /api/bets` | each past bet with its 7-day signup count, recomputed live |
| Measure (single campaign) | `GET /api/measure` | signups whose last-touch campaign matches |
| Site list | `GET /api/sites` | every site seen in events or bets; feeds the dashboard dropdown |
| Event types | `GET /api/events` | distinct event types + counts for a site; feeds the conversion-event picker |
| Auth | `LOOP_PASSWORD` env | shared password on dashboard + `/api/*`; `/collect` and `/loop.js` stay public |
| GA4 forwarding (optional) | `POST/GET /api/config` | server-side only, fire-and-forget after our own write; secret never echoed back |
| Dashboard | `server/dashboard.html` | full loop UI: recommendation, AI/template scripts with per-script approve, bets table, GA4 settings |
| Traffic simulator | `test/simulate.js` | seeds ~30 days of demo traffic for site `demo-saas` |
=======
# Loop — v1 Complete

Closed-loop marketing engine for solo SaaS founders. **All five stages working end-to-end:** Sense (track) → Decide (recommend) → Create (script) → Approve (review) → Measure (results).

## What's in v1

| Piece | File | Status |
|---|---|---|
| Tracking snippet | `snippet/loop.js` | ✅ first-touch + last-touch attribution, anonymous visitor id, `loop.track('signup')` |
| Ingestion + storage | `server/server.js` | ✅ Express + built-in `node:sqlite` (zero native deps) |
| Insights API | `GET /api/insights` | ✅ per-source visitors / signups / conversion, anomaly detection |
| Recommendation API | `GET /api/recommendation` | ✅ deterministic, evidence-weighted, refuses to bluff on thin data |
| Script generation | `GET /api/script` | ✅ hook → insight → CTA, grounded in conversion data |
| Approval + Publish | `POST /api/approve` | ✅ founder approves script, system tracks the bet |
| Measurement | `GET /api/measure` | ✅ 7-day attribution window via utm_campaign |
| Dashboard | `server/dashboard.html` | ✅ loop status strip, recommendation card, script card, measure card, source table |
| Traffic simulator | `test/simulate.js` | ✅ seeds 30 days of realistic traffic (site `demo-saas`) |
| Walkthrough guide | `WALKTHROUGH.md` | ✅ end-to-end scenario showing all 5 stages |
>>>>>>> 853c022efcecff3822ce1a5a43bba8e5890ad6f3

## Run it

```bash
cd server
<<<<<<< HEAD
npm install            # express only
node server.js         # → http://localhost:4070   (Node 22+)
```

Seed demo data (new terminal): `node test/simulate.js`, then open
`http://localhost:4070` — the site dropdown lists `demo-saas` automatically.

### Auth (shared password)

Set `LOOP_PASSWORD` to protect the dashboard and all management/read APIs:

```bash
LOOP_PASSWORD=some-long-secret node server.js
```

Then open the dashboard with the key in the URL: `http://localhost:4070/?key=some-long-secret`.
`/collect` and `/loop.js` stay public so visitors' browsers can reach them. With no
`LOOP_PASSWORD` set (local dev), auth is off and the server logs a warning. See
`DEPLOY.md` for hosting.

### Custom conversion events

`loop.track('signup')` is the default, but you can fire any event name —
`loop.track('trial')`, `loop.track('upgraded')`. The dashboard's event picker lists
whatever a site has recorded, and insights/recommendations pivot on the chosen event.
`GET /api/events?site=...` lists the types with counts.

### Multi-channel bets

When approving a script you can select multiple channels (reddit, x, linkedin, …).
Loop creates one bet per channel, each with its own `utm_campaign` suffix
(`loop-bet-1-reddit`, `loop-bet-1-x`, …) so their 7-day results never mix — letting
you compare the same script across channels.

### Enable AI script generation (optional)

Create `server/.env` (gitignored) containing:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Restart the server. Without a key, everything still works; the dashboard shows the
template script and says why. With a key, the Create card shows 3 generated scripts —
**cold start** (fresh hypotheses) until you have ≥3 measured bets and ≥5 attributed
signups, then **warm** (conditions on past script text + results + aggregates, with an
audience-level research summary and explicit confidence caveats). Details: `AI_SCRIPTS.md`.
=======
npm install          # express only
node server.js       # → http://localhost:4070  (Node 22+ required)
```

- Dashboard: `http://localhost:4070/` — pick site `demo-saas` after seeding
- Seed demo data: `node test/simulate.js`
- Manual snippet test: serve `server/test-page.html` (add a route or open via the server) and click Sign up
>>>>>>> 853c022efcecff3822ce1a5a43bba8e5890ad6f3

## Install on a real site (2 lines)

```html
<script src="https://YOUR-SERVER/loop.js" data-site="my-saas" defer></script>
```
<<<<<<< HEAD
After a successful signup:
=======
After a successful signup (thank-you page or signup callback):
>>>>>>> 853c022efcecff3822ce1a5a43bba8e5890ad6f3
```js
loop.track('signup');
```

<<<<<<< HEAD
## The loop, operationally

1. Traffic accumulates; dashboard shows per-source conversion (first-touch).
2. Once ≥3 signups and a source beats site average with ≥2 conversions, a
   recommendation appears with its evidence.
3. Create shows script ideas (AI or template). The founder approves one —
   it's saved as a bet with a unique `utm_campaign`.
4. The founder records/publishes it using that UTM.
5. For 7 days, signups carrying that campaign count toward the bet — visible
   live in the bets table.
6. Once enough bets have measured results, generation switches to warm mode
   and learns (at the audience level only) from what actually converted.

## Design decisions baked in

- **First-touch reporting** for "which channel creates demand"; last-touch stored and
  used for campaign measurement.
- **Manual `loop.track('signup')`** — one line, unambiguous across any stack.
- **Honest thresholds everywhere**: no recommendation below 3 signups; warm learning
  gated behind 3 bets / 5 measured signups; "no bet this week" instead of invented
  confidence.
- **Audience-level reasoning only** in the AI layer — never individual profiling.
- **Our data is the source of truth**; GA4 forwarding is an optional side-channel that
  can never block or break `/collect`.
- **No PII**: random visitor ids in localStorage; no emails, no fingerprinting.

## Known limitations (deliberate for v1)

- No auth — fine self-hosted for one founder; required before hosting others
  (the GA4 secret and `/api/config` especially).
- Low-traffic noise: below ~50 visitors/source, conversion differences are often
  luck; thresholds reduce but can't eliminate this.
- `signup` is the only first-class conversion event.
- AI generation needs a live `ANTHROPIC_API_KEY`; the build environment could not
  execute a paid API round-trip, so exercise that path locally (error handling for
  bad keys is tested and clean).
=======
## Design decisions baked in

- **First-touch reporting.** The loop asks "did this content create demand?", so
  credit goes to the discovering source. Last-touch is stored too for later.
- **Manual signup call, not auto-detect.** Unambiguous across any stack; the cost
  is one extra line at install.
- **Honest thresholds.** No recommendation below 3 total signups; a source needs
  ≥2 signups *and* above-average conversion to be a candidate; anomaly tag needs
  ≥2× site average with ≥20 visitors or ≥2 signups. When nothing qualifies, the
  product says "no bet this week" instead of inventing one.
- **Transparent why.** Every recommendation ships with the raw numbers behind it.
- **No PII.** Random visitor id in localStorage; no emails, no fingerprinting.


>>>>>>> 853c022efcecff3822ce1a5a43bba8e5890ad6f3

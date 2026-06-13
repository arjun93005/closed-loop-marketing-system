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

## Run it

```bash
cd server
npm install          # express only
node server.js       # → http://localhost:4070  (Node 22+ required)
```

- Dashboard: `http://localhost:4070/` — pick site `demo-saas` after seeding
- Seed demo data: `node test/simulate.js`
- Manual snippet test: serve `server/test-page.html` (add a route or open via the server) and click Sign up

## Install on a real site (2 lines)

```html
<script src="https://YOUR-SERVER/loop.js" data-site="my-saas" defer></script>
```
After a successful signup (thank-you page or signup callback):
```js
loop.track('signup');
```

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



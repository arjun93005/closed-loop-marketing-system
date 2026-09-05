# Loop v1 — End-to-End Walkthrough

This document shows how a solo founder completes the full loop in v1: install snippet → get insight → generate script → approve → publish → measure.

## Setup

```bash
cd server
npm install
node server.js          # http://localhost:4070
```

In another terminal:
```bash
cd test
node simulate.js        # Seeds 30 days of demo data (demo-saas site)
```

Open `http://localhost:4070` and select site `demo-saas` from the dropdown.

---

## The 5-Stage Flow

### **Stage 1: Sense ✅** (Live)
Your data is flowing. The dashboard shows:
- **Loop Status:** Sense dot is live (pulsing green)
- **Totals:** 508 visitors, 15 signups, 3.0% site conversion rate
- **Source breakdown:** Google, Reddit, ProductHunt, Twitter, LinkedIn, Direct with per-source conversions

The snippet is working. Every pageview and signup is tracked with first-touch and last-touch attribution.

---

### **Stage 2: Decide ✅** (Ready)
The dashboard shows a **Recommendation Card** with a headline insight:

> **ProductHunt converts 1.8x your site average**

The card explains *why*:
- 55 visitors from ProductHunt
- 3 signups (5.5% conversion)
- vs. 3.0% site average = 1.8× multiplier
- Window: 30 days
- These visitors are pre-qualified

The algorithm is honest:
- Won't recommend if you have < 3 total signups
- Won't pick a source unless it has ≥2 conversions AND beats site average
- Sorts by (conversion_rate × log(signups)) to balance quality with volume

---

### **Stage 3: Create ✅** (Ready)
Below the recommendation card, a **Script Card** appears:

**The Script** (45 seconds):
```
Hook: "Product Hunt sent me the best-converting traffic 
       I've ever seen. Here's why."

Body: "Turns out, 55 visitors from ProductHunt sent me 3 signups. 
       That's a 5.5% conversion rate — 1.8x better than my site average. 
       The reason? They're already pre-qualified when they arrive."

CTA:  "So I'm doubling down. I'm creating more content for the 
       ProductHunt audience this week. If you're building something 
       (and ProductHunt shows up in your analytics), this might be 
       worth testing too."
```

**Why this script?**
- It's grounded in real data (not AI speculation)
- It tells the founder's story (discovery of a hidden gem)
- It's authentic (sounds like a founder, not marketing copy)
- It includes the "why" so viewers understand the bet
- It's short enough to record and publish (Instagram Reel, TikTok, YouTube Short)

---

### **Stage 4: Approve ✅** (Manual)
The founder reviews the script and clicks **"Approve & Publish"** button.

The system responds:
```
✓ Approved
Ready to publish! Use utm_source=producthunt&utm_campaign=loop-bet-1 
when you share.
```

---

### **Stage 5: Measure ✅** (Manual)
The founder records the script and publishes it on ProductHunt's social channels with:
```
Check out Loop: https://yoursite.com?utm_source=producthunt&utm_campaign=loop-bet-1
```

After 7 days, they check the **Measure Card** on the dashboard.

The system shows:
```
Attributed Signups: 2
Your loop-bet-1 content drove 2 signup(s) in the last 7 days.
```

**The loop is complete.** The founder:
1. Found which source converts best (ProductHunt, 1.8× average)
2. Understood why (pre-qualified audience)
3. Created content grounded in that insight
4. Published it
5. Measured the result

---

## API Endpoints (for integration)

### Sense: `/collect` (POST)
The snippet sends events here. Already called automatically.

### Decide: `/api/recommendation` (GET)
```
GET /api/recommendation?site=demo-saas&days=30
```
Returns a recommendation card with headline, why, and evidence.

### Create: `/api/script` (GET)
```
GET /api/script?site=demo-saas&days=30
```
Returns a generated script ready to record.

### Approve: `/api/approve` (POST)
```
POST /api/approve
{ "site": "demo-saas", "campaign_name": "loop-bet-1" }
```
Logs the approval so the founder can track their bets.

### Measure: `/api/measure` (GET)
```
GET /api/measure?site=demo-saas&campaign=loop-bet-1
```
Returns signups attributed to this campaign in the last 7 days.

---

## What's Production-Ready in v1

✅ **Snippet** — tracks first-touch + last-touch attribution, no PII  
✅ **Ingestion** — stores events in local SQLite, CORS enabled  
✅ **Insights** — per-source conversion rates with anomaly detection  
✅ **Recommendation** — honest, deterministic, refuses weak signals  
✅ **Script generation** — data-grounded, authentic, recordable  
✅ **Approval UI** — dashboard approval button + API endpoint  
✅ **Measurement** — 7-day attribution window via UTM_campaign  

---

## What's NOT in v1 (Next Milestones)

- **Voiceover generation** (ElevenLabs) — planned for v1.1
- **Avatar video** (HeyGen) — v1.2, after voiceover works
- **Multi-channel distribution** — v1.1 (currently one site only)
- **Persistence for approvals** — v1.1 (currently ephemeral)
- **Auth + multi-tenancy** — v2 (self-hosted in v1)
- **Custom conversion events** — v2 (signup only in v1)

---

## Testing the Full Loop

### 1. Seed data:
```bash
node test/simulate.js
```

### 2. View insights:
```bash
curl http://localhost:4070/api/insights?site=demo-saas&days=30
```

### 3. Get recommendation:
```bash
curl http://localhost:4070/api/recommendation?site=demo-saas&days=30
```

### 4. Generate script:
```bash
curl http://localhost:4070/api/script?site=demo-saas&days=30
```

### 5. Approve:
```bash
curl -X POST http://localhost:4070/api/approve \
  -H 'Content-Type: application/json' \
  -d '{"site":"demo-saas","campaign_name":"loop-bet-1"}'
```

### 6. Check measurement (will be 0 in test):
```bash
curl http://localhost:4070/api/measure?site=demo-saas&campaign=loop-bet-1
```

---

## Key Design Decisions

**First-touch attribution:** We credit the source that *discovered* the visitor, not the last click. This answers "did this content marketing work?" vs. "who closed the deal?"

**Manual signup calls:** No auto-detection of form submits. Founders drop `loop.track('signup')` in their thank-you flow for perfect accuracy across any stack.

**Honest thresholds:** No recommendation under 3 total signups. Sources need ≥2 conversions. Anomaly detection uses 2× site average + real evidence (≥20 visitors or ≥2 signups).

**Data-grounded scripts:** Scripts are generated from conversion data, not prompts. Hook, body, and CTA all derive from "which source converts best and why?"

**7-day measurement window:** Realistic for social/content attribution. Longer windows dilute signal; shorter windows miss delayed conversions.

---

## For Design Partners

When testing with a real founder:

1. **Install the snippet** on their site (2 lines of code)
2. **Let traffic flow** for 7+ days
3. **Check `/api/insights`** to see per-source breakdown
4. **If 3+ signups**, use `/api/script` to generate a data-backed script
5. **Record and publish** the script to their top channel with UTMs
6. **After 7 days**, check `/api/measure` to see if it drove signups

The entire loop should take 2–3 weeks per founder per bet.

Expect low-volume noise: with <50 visitors per source, conversion rates are noisy. The thresholds reduce but don't eliminate this. That's why honest "wait another week" is better than a false recommendation.

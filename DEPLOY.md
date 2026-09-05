# Deploying Loop

Loop is one Node process + one SQLite file. Any host that runs Node 22+ and gives
you a persistent disk works. Below is the shortest safe path.

## 1. Environment variables

Set these in your host's env/secrets panel (never commit them):

| Variable | Purpose | Required? |
|---|---|---|
| `LOOP_PASSWORD` | Protects the dashboard + all management/read APIs. Without it, everything is open. | **Yes for any public deploy** |
| `ANTHROPIC_API_KEY` | Enables AI script generation. Without it, the template script is used. | Optional |
| `PORT` | Port to listen on (many hosts set this automatically). | Host-dependent |
| `LOOP_DB` | Path to the SQLite file. Point it at your persistent disk mount. | Recommended |

Locally you can instead put these in `server/.env` (already gitignored):
```
LOOP_PASSWORD=choose-a-long-random-string
ANTHROPIC_API_KEY=sk-ant-...
```

## 2. Persistent storage matters

`loop.db` holds all events and bets. If your host has an ephemeral filesystem
(many container platforms wipe disk on redeploy), point `LOOP_DB` at a mounted
volume, e.g. `LOOP_DB=/data/loop.db`, and attach a disk. Otherwise every deploy
resets your data.

## 3. Example: Railway / Render / Fly

1. Push this repo to GitHub.
2. Create a new service from the repo. Build command `npm install`, start command
   `node server.js`, working directory `server/`.
3. Add a persistent volume mounted at `/data`; set `LOOP_DB=/data/loop.db`.
4. Set `LOOP_PASSWORD` and (optionally) `ANTHROPIC_API_KEY` in the secrets panel.
5. Deploy. Note the public URL, e.g. `https://loop-yourname.up.railway.app`.

## 4. Point the snippet at your deployed URL

On each founder site, the two install lines become:
```html
<script src="https://loop-yourname.up.railway.app/loop.js" data-site="my-saas" defer></script>
```
```js
loop.track('signup');   // after a successful signup
```
`/collect` and `/loop.js` stay public (no password) so visitors' browsers reach them.

## 5. Open the dashboard

Because the dashboard is password-protected, open it with the key in the URL:
```
https://loop-yourname.up.railway.app/?key=YOUR_LOOP_PASSWORD
```
The page carries that key on every API call automatically. Treat this URL like a
password — anyone with it can see and manage your data (v1 has one shared password,
no per-user accounts).

## 6. Sanity check after deploy

- `GET /loop.js` returns the script with no password → public path works.
- `GET /api/insights?site=...` **without** a key returns 401 → auth is on.
- Opening `/?key=...` shows the dashboard and lists your sites → end to end works.

## Security notes (v1, honest)

- One shared password, sent as a Bearer token or `?key=`. Fine for a single founder
  or a trusted small group; it is not per-user auth and there's no rate limiting.
- The GA4 API secret is stored in SQLite in plaintext. On your own single-tenant
  deploy that's acceptable (you own the disk); it would need encryption before
  hosting multiple unrelated founders.
- Always serve over HTTPS (all the hosts above do by default) so the password and
  data aren't sent in the clear.

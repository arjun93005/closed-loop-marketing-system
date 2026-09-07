# Deploying Loop

Loop is one Node process + one SQLite file. Any host that runs Node 22+ and gives
you a persistent disk works. Below is the shortest safe path.

## 1. Environment variables

Set these in your host's env/secrets panel (never commit them):

| Variable | Purpose | Required? |
|---|---|---|
| `NODE_ENV` | `development`, `production` or `test`. Setting `production` turns on the strict checks below. | **Yes for any public deploy** |
| `LOOP_PASSWORD` | Protects the dashboard + all management/read APIs. Min 16 chars in production. | **Yes** (enforced when `NODE_ENV=production`) |
| `LOOP_DB` | Path to the SQLite file. Point it at your persistent disk mount. | **Strongly recommended** |
| `ANTHROPIC_API_KEY` | Enables AI script generation. Without it, the template script is used. | Optional |
| `PORT` | Port to listen on (many hosts set this automatically). | Host-dependent |

### Configuration is validated at boot

All of these are read, validated and frozen in one place — `server/config.js`. Nothing
else in the app touches `process.env`. If anything is wrong the server prints every
problem at once and **exits with code 1** rather than starting in a broken state:

```
Invalid configuration — the server cannot start:
  ✗ LOOP_PASSWORD is required when NODE_ENV=production. Without it the dashboard
    and all /api/* routes would be publicly readable and writable.
```

A non-zero exit is what makes your host mark the deploy as failed instead of routing
live traffic at it. Specifically, the server refuses to start when:

- `NODE_ENV` is not one of the three known values (catches typos like `prodution`),
- `PORT` is not an integer in 1–65535,
- `NODE_ENV=production` and `LOOP_PASSWORD` is missing or under 16 characters,
- `LOOP_DB`’s parent directory does not exist — which is how you learn the persistent
  volume was never mounted **before** losing data rather than after.

On boot it prints the effective settings, with secrets shown as present/absent only:

```
[config] env      production
[config] port     8080
[config] database /data/loop.db
[config] auth     ON (LOOP_PASSWORD set)
[config] ai       ON (ANTHROPIC_API_KEY set)
```

Every supported variable is documented in `server/.env.example`. Locally, copy it to
`server/.env` (gitignored) instead of exporting variables by hand:

```bash
cp server/.env.example server/.env
```

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

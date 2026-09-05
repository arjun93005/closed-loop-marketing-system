/**
 * Simulates 30 days of realistic traffic for site "demo-saas" by POSTing the
 * exact payloads the snippet would send. Lets us test Sense + Decide with no users.
 *
 * Run: node test/simulate.js  (server must be running)
 */
const ENDPOINT = process.env.LOOP_URL || 'http://localhost:4070/collect';

// source: [visitors, signupRate, campaign]
const PROFILE = {
  'google':       [180, 0.022, null],
  'direct':       [120, 0.025, null],
  'twitter.com':  [90,  0.033, 'build-in-public'],
  'reddit.com':   [38,  0.105, 'r-saas-comment'],   // the hidden gem the loop should find
  'producthunt':  [55,  0.036, 'ph-launch'],
  'linkedin.com': [25,  0.0,   null],
};

const LANDINGS = ['/', '/pricing', '/blog/why-we-built-this', '/features'];
const rand = a => a[Math.floor(Math.random() * a.length)];
const uid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

async function post(body) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status !== 204) throw new Error(`collect failed: ${r.status} ${await r.text()}`);
}

(async () => {
  let events = 0, signups = 0;
  for (const [source, [visitors, rate, campaign]] of Object.entries(PROFILE)) {
    for (let i = 0; i < visitors; i++) {
      const vid = uid();
      const daysAgo = Math.random() * 28;
      const ts = Date.now() - daysAgo * 86400000;
      const landing = source === 'reddit.com' ? (Math.random() < 0.7 ? '/blog/why-we-built-this' : rand(LANDINGS)) : rand(LANDINGS);
      const touch = {
        source: source === 'direct' ? 'direct' : source,
        medium: source === 'direct' ? 'none' : (campaign ? 'social' : 'referral'),
        campaign, content: null, term: null,
        referrer: source === 'direct' ? null : `https://${source}/`,
        landing, at: ts
      };
      const base = { site: 'demo-saas', vid, ft: touch, lt: touch, props: null };

      await post({ ...base, type: 'pageview', url: landing, referrer: touch.referrer, ts }); events++;
      // some visitors browse a second page
      if (Math.random() < 0.4) { await post({ ...base, type: 'pageview', url: rand(LANDINGS), referrer: null, ts: ts + 60000 }); events++; }
      // conversion
      if (Math.random() < rate) {
        await post({ ...base, type: 'signup', url: '/welcome', referrer: null, ts: ts + 180000 });
        events++; signups++;
      }
    }
  }
  console.log(`Seeded ${events} events, ${signups} signups across ${Object.keys(PROFILE).length} sources.`);
})();

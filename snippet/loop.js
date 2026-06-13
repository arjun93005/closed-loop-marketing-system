/**
 * Loop tracking snippet — v1
 *
 * Install (2 lines):
 *   <script src="https://YOUR-LOOP-SERVER/loop.js" data-site="my-saas" defer></script>
 * Then fire the conversion event after a successful signup:
 *   loop.track('signup');
 *
 * What it captures:
 *  - Anonymous visitor id (random, localStorage; no PII, no fingerprinting)
 *  - First-touch attribution: the source that *discovered* this visitor (never overwritten)
 *  - Last-touch attribution: the source of the current session (30-min session window)
 *  - Pageviews (path, referrer) and signup conversions
 */
(function () {
  'use strict';
  if (window.loop && window.loop.__v1) return; // double-install guard

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  var SITE = (script && script.getAttribute('data-site')) || 'default';
  var ENDPOINT = (script && script.getAttribute('data-endpoint')) ||
    (script && script.src ? script.src.replace(/\/loop\.js.*$/, '') + '/collect' : '/collect');

  var LS = window.localStorage;
  var SESSION_WINDOW_MS = 30 * 60 * 1000;

  function uid() {
    try {
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (e) {
      return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }
  }

  function getJSON(key) {
    try { return JSON.parse(LS.getItem(key)); } catch (e) { return null; }
  }
  function setJSON(key, val) {
    try { LS.setItem(key, JSON.stringify(val)); } catch (e) { /* storage blocked */ }
  }

  // --- Visitor identity (anonymous) ---
  var visitorId = LS ? LS.getItem('loop_vid') : null;
  if (!visitorId) {
    visitorId = uid();
    try { LS.setItem('loop_vid', visitorId); } catch (e) {}
  }

  // --- Attribution capture ---
  function currentTouch() {
    var p = new URLSearchParams(window.location.search);
    var ref = document.referrer || '';
    var refHost = '';
    try { refHost = ref ? new URL(ref).hostname.replace(/^www\./, '') : ''; } catch (e) {}
    var internal = refHost && refHost === window.location.hostname.replace(/^www\./, '');

    var source = p.get('utm_source') || (internal ? null : refHost) || null;
    return {
      source: source || 'direct',
      medium: p.get('utm_medium') || (source && !p.get('utm_source') ? 'referral' : (source ? null : 'none')),
      campaign: p.get('utm_campaign') || null,
      content: p.get('utm_content') || null,
      term: p.get('utm_term') || null,
      referrer: internal ? null : (ref || null),
      landing: window.location.pathname,
      at: Date.now()
    };
  }

  // First touch: set once, never overwritten — credits the source that discovered the visitor.
  var firstTouch = getJSON('loop_ft');
  if (!firstTouch) {
    firstTouch = currentTouch();
    setJSON('loop_ft', firstTouch);
  }

  // Last touch: refreshed when a *new session* starts (30 min of inactivity, or an
  // arrival with explicit campaign/referrer info, which signals a new marketing touch).
  var lastSeen = parseInt(LS && LS.getItem('loop_seen') || '0', 10);
  var lastTouch = getJSON('loop_lt');
  var now = Date.now();
  var touchNow = currentTouch();
  var isNewSession = !lastTouch || (now - lastSeen) > SESSION_WINDOW_MS;
  var hasExplicitTouch = touchNow.source !== 'direct';
  if (isNewSession || hasExplicitTouch) {
    lastTouch = touchNow;
    setJSON('loop_lt', lastTouch);
  }
  try { LS.setItem('loop_seen', String(now)); } catch (e) {}

  // --- Transport ---
  function send(type, props) {
    var payload = JSON.stringify({
      site: SITE,
      vid: visitorId,
      type: type,                       // 'pageview' | 'signup' | custom
      url: window.location.pathname,
      referrer: document.referrer || null,
      ft: firstTouch,                   // first-touch attribution
      lt: lastTouch,                    // last-touch attribution
      props: props || null,
      ts: Date.now()
    });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }))) return;
    } catch (e) {}
    try {
      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
    } catch (e) {}
  }

  // --- Public API ---
  window.loop = {
    __v1: true,
    track: function (eventName, props) { send(String(eventName || 'event'), props); },
    visitorId: visitorId
  };

  send('pageview');
})();

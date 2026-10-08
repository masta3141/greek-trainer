// sw.js — service worker for the Griechisch Trainer PWA.
//
// Network first (revalidated with cache: 'no-cache'), the cache is only the
// offline fallback. Only same-origin GETs are handled; everything else goes
// straight to the network. Bump CACHE_NAME when any shell file changes and
// keep APP_SHELL in sync with the <link>/<script> tags in index.html.

var CACHE_PREFIX = 'grtrain-shell-';
var CACHE_NAME = CACHE_PREFIX + 'v4';
var APP_SHELL = [
  'index.html',
  'css/app.css',
  'data/words.js',
  'js/core.js',
  'js/i18n.js',
  'js/gemini.js',
  'js/speech.js',
  'js/session.js',
  'js/streak.js',
  'js/cards.js',
  'js/stories.js',
  'js/vocab.js',
  'js/settings.js',
  'js/backup.js',
  'js/navigation.js',
  'js/init.js',
  'data/forms.json',
  'manifest.json',
  'icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        // Only our own old caches: other apps on the same origin (e.g. the
        // HSK Trainer at /chinese-trainer/) share the Cache Storage.
        return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME; })
                               .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      })
      .catch(function () { return caches.match(event.request); })
  );
});

// sw.js — オフライン対応（アプリ本体をキャッシュ）
// 更新を配布するときは VERSION を上げること

const VERSION = 'framelab-v0.4.0';
const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/main.js',
  './js/store.js',
  './js/importer.js',
  './js/player.js',
  './js/timeline.js',
  './js/exporter.js',
  './js/exporter-wc.js',
  './js/renderer.js',
  './js/audio-mix.js',
  './js/db.js',
  './js/persist.js',
  './js/audio.js',
  './js/jetcut.js',
  './js/subtitles.js',
  './js/whisper-worker.js',
  './js/glfx.js',
  './js/luts.js',
  './js/titles.js',
  './js/music.js',
  './js/vendor/mp4-muxer.mjs',
  './lut/manifest.json',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同一オリジンの応答にCOOP/COEPヘッダを付与する。
// これでSharedArrayBufferが使えるようになり、字幕AI(WASM)がマルチスレッドで動く
function withIsolationHeaders(response) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;
  e.respondWith(
    caches.match(e.request)
      .then(hit => {
        if (hit) return hit;
        return fetch(e.request).then(res => {
          // LUTバイナリは初回取得時にキャッシュしてオフライン対応
          if (sameOrigin && url.pathname.includes('/lut/') && res.ok) {
            const clone = res.clone();
            caches.open(VERSION).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
      .then(res => sameOrigin ? withIsolationHeaders(res) : res)
  );
});

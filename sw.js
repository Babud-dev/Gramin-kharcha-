/**
 * sw.js — Gramin Kharcha Service Worker
 * Offline-first, low-bandwidth optimised PWA
 * Developed by: Shamir Aftab, Shivani Singh, Yachika Gadekar
 * SAGE University
 */

const APP_NAME    = 'gramin-kharcha';
const CACHE_VER   = 'v1.0.0';
const CACHE_STATIC = `${APP_NAME}-static-${CACHE_VER}`;
const CACHE_FONTS  = `${APP_NAME}-fonts-${CACHE_VER}`;
const CACHE_DYNAMIC = `${APP_NAME}-dynamic-${CACHE_VER}`;

// ── Assets to pre-cache on install ──────────────────────────────────────────
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
];

// ── External origins allowed in font cache ───────────────────────────────────
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// ── Max entries for dynamic cache (keeps storage lean on low-end devices) ────
const DYNAMIC_CACHE_MAX = 30;


// ════════════════════════════════════════════════════════════════════════════
// INSTALL — pre-cache all static assets
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log(`[SW] Installing ${CACHE_STATIC}`);
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => {
        console.log('[SW] Pre-caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting()) // activate new SW immediately
  );
});


// ════════════════════════════════════════════════════════════════════════════
// ACTIVATE — clean up old caches
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log(`[SW] Activating ${CACHE_VER}`);
  const validCaches = [CACHE_STATIC, CACHE_FONTS, CACHE_DYNAMIC];

  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(APP_NAME) && !validCaches.includes(key))
          .map(key => {
            console.log(`[SW] Deleting old cache: ${key}`);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim()) // take control of all open tabs
  );
});


// ════════════════════════════════════════════════════════════════════════════
// FETCH — routing strategies
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // 1. Google Fonts — Cache First (fonts rarely change)
  if (FONT_ORIGINS.some(origin => request.url.startsWith(origin))) {
    event.respondWith(cacheFirst(request, CACHE_FONTS));
    return;
  }

  // 2. Static app shell — Cache First, fallback to network
  if (STATIC_ASSETS.some(asset => url.pathname.endsWith(asset.replace('./', '/')))) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // 3. Anthropic API calls — Network Only (never cache AI responses)
  if (url.hostname === 'api.anthropic.com') {
    event.respondWith(networkOnly(request));
    return;
  }

  // 4. Everything else — Network First, fallback to cache
  //    (Stale-While-Revalidate for low-data: serve cache instantly, refresh in bg)
  event.respondWith(staleWhileRevalidate(request));
});


// ════════════════════════════════════════════════════════════════════════════
// STRATEGY HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cache First — ideal for static assets & fonts
 * Serves from cache instantly; fetches from network only on cache miss.
 * Great for 2G/3G: zero network round-trip for cached resources.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Stale While Revalidate — ideal for dynamic content
 * Returns cached response immediately (fast on slow networks),
 * then updates the cache in the background.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_DYNAMIC);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(response => {
      if (response.ok) {
        cache.put(request, response.clone());
        trimCache(cache, DYNAMIC_CACHE_MAX);
      }
      return response;
    })
    .catch(() => null);

  return cached || await networkFetch || offlineFallback(request);
}

/**
 * Network Only — for API calls that must be fresh
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Offline — no network connection' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Offline Fallback — returns cached index.html for navigation requests
 */
async function offlineFallback(request) {
  if (request.destination === 'document') {
    const cache = await caches.open(CACHE_STATIC);
    return cache.match('./index.html') || cache.match('/');
  }
  // For other failed requests return a minimal empty response
  return new Response('', { status: 408, statusText: 'Offline' });
}


// ════════════════════════════════════════════════════════════════════════════
// CACHE TRIMMING — keeps storage lean on low-end rural devices
// ════════════════════════════════════════════════════════════════════════════
async function trimCache(cache, maxItems) {
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    // Delete oldest entries (FIFO)
    const toDelete = keys.slice(0, keys.length - maxItems);
    await Promise.all(toDelete.map(key => cache.delete(key)));
    console.log(`[SW] Trimmed ${toDelete.length} old cache entries`);
  }
}


// ════════════════════════════════════════════════════════════════════════════
// BACKGROUND SYNC — queue failed requests when offline (e.g. AI tips)
// Re-sends them automatically when connectivity is restored
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'sync-expenses') {
    console.log('[SW] Background sync triggered: sync-expenses');
    event.waitUntil(syncExpenses());
  }
});

async function syncExpenses() {
  // Expenses are stored in localStorage (handled by the app).
  // This hook is here for future cloud-sync integration.
  console.log('[SW] Expense sync complete (local-only mode)');
}


// ════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS — saving reminders & govt scheme alerts
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Gramin Kharcha 🌾';
  const options = {
    body: data.body || 'Aaj ka kharcha track karna mat bhoolein!',
    icon: 'icons/icon-192x192.png',
    badge: 'icons/icon-72x72.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || './' },
    actions: [
      { action: 'open',    title: '📖 Open App' },
      { action: 'dismiss', title: '✕ Dismiss'  },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        const url = event.notification.data.url || './';
        const existing = clientList.find(c => c.url.includes('index.html') && 'focus' in c);
        if (existing) return existing.focus();
        return clients.openWindow(url);
      })
  );
});


// ════════════════════════════════════════════════════════════════════════════
// MESSAGE CHANNEL — communicate with the main app thread
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VER });
  }
});

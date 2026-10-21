// Web Share Target handler, imported into the Workbox-generated service worker
// (see vite.config.ts workbox.importScripts). When the OS "Share" sheet sends a file
// to Perch, Android POSTs a multipart body to /share-target (declared in the manifest's
// share_target). We stash the bytes in the Cache API and redirect to the app, which
// reads them once at boot (core/shared-file.ts + store.loadSharedFile) and offers to
// attach the file to a session.
//
// The field was named `image` before the target accepted every type. An installed PWA
// keeps its old manifest until it is reinstalled from the home screen, so the OS goes on
// POSTing `image` to this already-updated worker — read both names or sharing silently
// breaks for anyone who hasn't reinstalled.
//
// Only this exact POST is claimed; everything else falls through to Workbox's own router
// (a POST is never a navigation GET, so there is no contention).
//
// The OS starts a share itself, so it carries no referrer (and `Sec-Fetch-Site: none` where the
// browser shows that header to the worker). A form on some other site can POST here as well; that
// one is dropped rather than stashed, so a page cannot plant a file the app then uploads. A page
// that hides its referrer gets past this: it is a hurdle, not a proof.
function isOsShare(request) {
  const site = request.headers.get('sec-fetch-site');
  return request.referrer === '' && (site === null || site === 'none');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
  if (!isOsShare(event.request)) {
    event.respondWith(Response.redirect('/', 303));
    return;
  }
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const file = form.get('file') ?? form.get('image');
        if (file) {
          const cache = await caches.open('perch-shared');
          await cache.put(
            '/shared-file',
            new Response(file, {
              headers: {
                'content-type': file.type || 'application/octet-stream',
                'x-filename': file.name || '',
              },
            }),
          );
        }
      } catch {
        // A malformed share shouldn't break navigation; fall through to opening the app.
      }
      return Response.redirect('/?shared=1', 303);
    })(),
  );
});

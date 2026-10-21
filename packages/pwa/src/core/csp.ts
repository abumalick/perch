// The PWA's Content-Security-Policy, emitted as a <meta> into index.html at build (vite.config.ts).
// The origin holds every machine entry and the device keys, so the point is that no script but
// the app's own bundle ever runs here: not an agent-supplied blob (which inherits this policy),
// not markup in a rendered document.
// - connect-src: relays are wherever their owners put them (a Worker, a tailnet host), so any
//   https/wss host, plus loopback for a hand-run relay and the e2e. ElevenLabs is https too.
// - img-src keeps a document's remote images from reporting when and where it was opened.
// - style-src needs 'unsafe-inline': xterm injects <style> elements and Svelte sets style attributes.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src blob:",
  "worker-src 'self'",
  "connect-src 'self' https: wss: ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

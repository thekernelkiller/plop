const CACHE = "plop-shell-v1";
const shell = ["./index.html", "./app.js", "./firebase-config.js", "./markdown.js", "./styles.css", "./env.json"];
const firebase = "https://www.gstatic.com/firebasejs/10.8.0/";
const dependencies = [
  firebase + "firebase-app.js", firebase + "firebase-auth.js", firebase + "firebase-firestore.js",
  "https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js",
  "https://cdn.jsdelivr.net/npm/dompurify@3.4.0/dist/purify.es.mjs"
];
const shellUrls = new Set(shell.map((path) => new URL(path, self.registration.scope).href));
const dependencyUrls = new Set(dependencies);
const index = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...shell, ...dependencies])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("plop-shell-") && key !== CACHE)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const appRoot = new URL(self.registration.scope);
  const navigation = request.mode === "navigate" && url.origin === appRoot.origin &&
    [appRoot.pathname, new URL(index).pathname].includes(url.pathname);
  if (dependencyUrls.has(request.url)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  } else if (navigation || shellUrls.has(request.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = navigation ? index : request.url;
      try {
        const response = await fetch(request);
        if (!response.ok) return response.status >= 500 ? (await cache.match(key)) || response : response;
        await cache.put(key, response.clone());
        return response;
      } catch {
        return (await cache.match(key)) || Response.error();
      }
    })());
  }
});

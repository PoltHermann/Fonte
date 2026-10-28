/* Fonte — service worker : fonctionnement hors ligne.
 *
 * À placer dans le MÊME dossier que fonte.html (ou index.html) sur GitHub Pages.
 * Stratégie « stale-while-revalidate » pour tout ce qui est servi depuis ce dossier :
 * la copie en cache est affichée tout de suite (donc l'app s'ouvre sans réseau),
 * puis rafraîchie en arrière-plan. Une nouvelle version publiée apparaît donc
 * au lancement SUIVANT (l'app affiche un message quand elle est téléchargée).
 *
 * Les données (séances, historique…) restent dans le localStorage : ce fichier
 * ne touche jamais à elles. Pour forcer le vidage du cache, changer VERSION.
 */
var VERSION = "fonte-sw-v1";
var SHELL_KEY = "./__shell__"; // dernière page chargée, utilisée en secours hors ligne

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    var names = await caches.keys();
    await Promise.all(names
      .filter(function (n) { return n.indexOf("fonte-") === 0 && n !== VERSION; })
      .map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
    // Première visite : la page s'est chargée avant le service worker, donc il ne l'a
    // jamais vue passer. On met en cache les pages de l'app déjà ouvertes.
    var cache = await caches.open(VERSION);
    var clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(clients
      .filter(function (c) { return c.url.indexOf(self.registration.scope) === 0; })
      .map(function (c) { return precache(cache, c.url); }));
  })());
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.url.indexOf(self.registration.scope) !== 0) return;
  event.respondWith(handle(event, req));
});

self.addEventListener("message", function (event) {
  if (!event.data || event.data.type !== "status") return;
  var source = event.source;
  event.waitUntil((async function () {
    var cache = await caches.open(VERSION);
    var shell = await cache.match(SHELL_KEY);
    if (source) source.postMessage({ type: "fonte-status", ready: !!shell, version: VERSION });
  })());
});

// Une réponse issue d'une redirection ne peut pas être servie à une navigation (Safari la refuse) :
// on la recopie en réponse « propre ».
async function cleanResponse(res) {
  if (!res.redirected) return res;
  var body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function precache(cache, url) {
  try {
    url = url.split("#")[0];
    var res = await fetch(url, { cache: "no-cache", credentials: "same-origin" });
    if (res && res.ok) {
      var clean = await cleanResponse(res);
      await cache.put(url, clean.clone());
      await cache.put(SHELL_KEY, clean);
    }
  } catch (e) { /* hors ligne : on réessaiera au prochain lancement */ }
}

// Vrai si le CONTENU de la page téléchargée diffère de la copie en cache.
// (On compare le texte, pas les en-têtes : l'ETag / Last-Modified d'un CDN peuvent varier d'une
// requête à l'autre pour un fichier identique, ce qui affichait « nouvelle version » à chaque lancement.)
async function sameBody(a, b) {
  try {
    var texts = await Promise.all([a.text(), b.text()]);
    return texts[0] === texts[1];
  } catch (e) {
    return true; // doute : on ne dérange pas l'utilisateur
  }
}

async function notifyUpdate() {
  var clients = await self.clients.matchAll({ type: "window" });
  clients
    .filter(function (c) { return c.url.indexOf(self.registration.scope) === 0; })
    .forEach(function (c) { c.postMessage({ type: "fonte-update" }); });
}

async function handle(event, req) {
  var cache = await caches.open(VERSION);
  var cached = await cache.match(req, { ignoreSearch: true });
  var forCompare = cached ? cached.clone() : null; // copie pour la comparaison : `cached` est consommé par la page
  var isNav = req.mode === "navigate";

  var refresh = (async function () {
    try {
      var res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
      if (!res || !res.ok) return null;
      var clean = await cleanResponse(res);
      await cache.put(req.url, clean.clone());
      if (isNav) await cache.put(SHELL_KEY, clean.clone());
      if (isNav && forCompare && !(await sameBody(forCompare, clean.clone()))) await notifyUpdate();
      return clean;
    } catch (e) {
      return null; // hors ligne
    }
  })();

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  var fresh = await refresh;
  if (fresh) return fresh;
  if (isNav) {
    var shell = await cache.match(SHELL_KEY);
    if (shell) return shell;
  }
  return Response.error();
}

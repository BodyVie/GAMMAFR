/* =========================================================================
   GAMMA · Traduction FR — service worker (PWA hors-ligne).
   - Précache la coquille de l'app (HTML/CSS/JS/icônes) à l'installation.
   - Navigation : réseau d'abord, repli sur l'index hors-ligne.
   - data/*.json : réseau d'abord (fraîcheur), repli cache.
   - Autres ressources même-origine : cache d'abord, mise à jour en tâche de fond.
   - Le Worker Cloudflare et les ressources externes ne sont JAMAIS interceptés.
   Chemins relatifs : fonctionne sous GitHub Pages projet (/REPO/) comme à la racine.
   ========================================================================= */
"use strict";

var CACHE = "gammafr-v1";
var CORE = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/core.js",
  "./js/zip.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./assets/favicon.svg",
  "./assets/apple-touch-icon.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function putInCache(req, res) {
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); });
  return res;
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Worker Cloudflare & externes : réseau direct

  // navigation → réseau d'abord, repli sur l'index mis en cache (hors-ligne)
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(function () { return caches.match("./index.html"); }));
    return;
  }

  // data/*.json → réseau d'abord (contenu frais après une édition admin), repli cache
  if (url.pathname.indexOf("/data/") !== -1) {
    e.respondWith(
      fetch(req).then(function (res) { return putInCache(req, res); })
        .catch(function () { return caches.match(req); })
    );
    return;
  }

  // autres ressources même-origine → cache d'abord, mise à jour en tâche de fond
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) { return putInCache(req, res); }).catch(function () { return cached; });
      return cached || net;
    })
  );
});

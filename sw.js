/* =========================================================================
   GAMMA · Traduction FR — ancien service worker, désormais NEUTRALISÉ.
   La PWA / le cache hors-ligne ont été retirés. Ce fichier ne sert plus qu'à
   « désinstaller » proprement un service worker déjà enregistré chez un
   visiteur : il vide les caches puis se désinscrit lui-même.
   Ne pas le supprimer tant que d'anciens SW peuvent traîner : un sw.js absent
   (404) n'annule PAS un SW existant — il faut ce tombstone pour s'auto-retirer.
   ========================================================================= */
"use strict";

self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.claim(); })
  );
});

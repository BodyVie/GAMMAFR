/* =========================================================================
   GAMMA · Traduction FR — logique pure, sans DOM ni dépendance.
   Partagée entre le navigateur (window.GammaCore) et Node (require) afin
   d'être testable hors navigateur (voir tests/).
   ========================================================================= */
(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.GammaCore = api;
})(function () {
  "use strict";

  // Dernier segment d'un chemin POSIX (nom de fichier).
  function baseName(path) {
    var p = String(path).split("/");
    return p[p.length - 1];
  }

  // Comparaison de versions « x.y.z » : <0 si a<b, 0 si égales, >0 si a>b.
  function cmpVersion(a, b) {
    var pa = String(a || "").split(".").map(Number);
    var pb = String(b || "").split(".").map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  // Comparaison « naturelle » de chaînes : les segments numériques sont comparés
  // comme des nombres et non caractère par caractère, de sorte que
  // « 9 » < « 10 » < « 90 » < « 200 » (et non l'ordre lexicographique où « 200 »
  // précède « 90 »). Sert à trier les dossiers de patchs préfixés d'un numéro
  // (« 94- … » avant « 208- … »). Insensible à la casse et aux accents.
  function cmpNatural(a, b) {
    return String(a == null ? "" : a).localeCompare(
      String(b == null ? "" : b),
      "fr",
      { numeric: true, sensitivity: "base" }
    );
  }

  /**
   * Résolution des conflits par priorité.
   * Entrée : sources = [{ label, priority, files: [chemins] }].
   * Pour chaque nom de fichier (dernier segment), la source de priorité la plus
   * élevée gagne ; à égalité, ordre alphabétique du label (gagnant déterministe)
   * et le fichier est marqué « conflit ».
   * Sortie : { files: [{ name, winner, conflict, contenders }], warnings: [name] }
   */
  function resolveFiles(sources) {
    var map = {};
    (sources || []).forEach(function (s) {
      (s.files || []).forEach(function (path) {
        var b = baseName(path);
        (map[b] = map[b] || []).push({ path: path, label: s.label, priority: s.priority });
      });
    });

    var files = [], warnings = [];
    Object.keys(map).sort().forEach(function (b) {
      var arr = map[b].slice().sort(function (x, y) {
        if (y.priority !== x.priority) return y.priority - x.priority;
        return x.label < y.label ? -1 : (x.label > y.label ? 1 : 0);
      });
      var top = arr[0];
      var conflict = arr.filter(function (s) { return s.priority === top.priority; }).length > 1;
      if (conflict) warnings.push(b);
      files.push({ name: b, winner: top, conflict: conflict, contenders: arr });
    });
    return { files: files, warnings: warnings };
  }

  return { baseName: baseName, cmpVersion: cmpVersion, cmpNatural: cmpNatural, resolveFiles: resolveFiles };
});

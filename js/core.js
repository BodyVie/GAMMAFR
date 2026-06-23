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

  /* =========================================================================
     SAUVEGARDE / RESTAURATION DE LA SÉLECTION DU CONFIGURATEUR
     -------------------------------------------------------------------------
     « Reprendre son pack en un clic » : un fichier texte (ModListeConfigurateur.txt)
     est glissé automatiquement dans chaque archive générée. Re-déposé plus tard
     dans le configurateur — typiquement après une mise à jour du pack — il recoche
     toute la sélection sans refaire le parcours. Format texte volontairement
     LISIBLE (ouvrable au Bloc-notes) : un en-tête en commentaires (#), une ligne
     « Niveau = … », puis un nom de patch par ligne. Logique pure (aucun DOM) afin
     d'être testée hors navigateur ; le câblage (glisser-déposer, écriture dans le
     ZIP) vit dans js/app.js.
     ========================================================================= */
  var CONFIG_FILE_BASENAME = "ModListeConfigurateur";
  var CONFIG_FILE_NAME = "ModListeConfigurateur.txt";
  // Marqueur recherché pour valider qu'un fichier déposé est bien le nôtre
  // (et pas un .txt quelconque). Présent dans l'en-tête généré ci-dessous.
  var CONFIG_TXT_MARKER = "ModListeConfigurateur";

  // Construit le contenu texte du fichier à partir de la sélection.
  // level   : "base" | "tweak" | "extra"
  // groups  : [{ title, items:[noms de patchs] }] (sections vides ignorées)
  // meta    : { app, savedAt } (facultatif) — repris en commentaires d'en-tête.
  function buildConfigText(level, groups, meta) {
    meta = meta || {};
    var L = [];
    L.push("# GAMMA.FR · " + CONFIG_FILE_BASENAME + " · format v1");
    L.push("# Fichier généré automatiquement par le configurateur GAMMA.FR.");
    L.push("# Glissez-le dans le configurateur (étape « Niveau ») pour recocher votre sélection.");
    L.push("# Ne modifiez pas les lignes ci-dessous.");
    if (meta.app) L.push("# Version du site : " + meta.app);
    if (meta.savedAt) L.push("# Généré le : " + meta.savedAt);
    L.push("");
    L.push("Niveau = " + (level || ""));
    (groups || []).forEach(function (g) {
      if (!g || !g.items || !g.items.length) return;
      L.push("");
      L.push("# " + g.title);
      g.items.forEach(function (name) { L.push(String(name)); });
    });
    L.push("");
    return L.join("\r\n");
  }

  // Lit et valide le contenu texte d'un fichier déposé.
  // idsForLevel : tableau d'ids valides, ou fonction (level) -> [ids] (laisse
  // l'appelant calculer les patchs disponibles pour le niveau lu dans le fichier).
  // Renvoie { level, selected:{id:true}, matched:[ids], missing:[ids] } où
  // « missing » liste les patchs du fichier qui n'existent plus (renommés ou
  // retirés depuis la sauvegarde). Lève une Error (message en français, affiché
  // tel quel) si le fichier n'est pas un ModListeConfigurateur valide.
  function parseConfigText(text, idsForLevel) {
    if (typeof text !== "string") throw new Error("Fichier illisible.");
    // BOM UTF-8 éventuel en tête (ajouté pour l'affichage des accents sous Windows).
    var clean = (text.charCodeAt(0) === 0xFEFF) ? text.slice(1) : text;
    if (clean.indexOf(CONFIG_TXT_MARKER) === -1) {
      throw new Error("Fichier non compatible : seul le fichier " + CONFIG_FILE_NAME + " est accepté.");
    }
    var level = null, names = [];
    clean.split(/\r\n|\r|\n/).forEach(function (line) {
      var s = line.trim();
      if (!s || s.charAt(0) === "#") return;            // vide ou commentaire
      var m = /^niveau\s*[=:]\s*(.+)$/i.exec(s);
      if (m) { if (level === null) level = m[1].trim().toLowerCase(); return; }
      names.push(s);                                     // nom de patch
    });
    if (level !== "base" && level !== "tweak" && level !== "extra") {
      throw new Error("Fichier non compatible : niveau manquant ou inconnu.");
    }
    if (level === "base") return { level: level, selected: {}, matched: [], missing: [] };

    var valid = (typeof idsForLevel === "function") ? idsForLevel(level) : idsForLevel;
    var validSet = {};
    (valid || []).forEach(function (id) { validSet[id] = true; });

    var matched = [], missing = [], selected = {};
    names.forEach(function (id) {
      if (validSet[id]) { if (!selected[id]) { matched.push(id); selected[id] = true; } }
      else missing.push(id);
    });
    return { level: level, selected: selected, matched: matched, missing: missing };
  }

  return {
    baseName: baseName, cmpVersion: cmpVersion, cmpNatural: cmpNatural,
    resolveFiles: resolveFiles,
    buildConfigText: buildConfigText, parseConfigText: parseConfigText,
    CONFIG_FILE_NAME: CONFIG_FILE_NAME, CONFIG_FILE_BASENAME: CONFIG_FILE_BASENAME
  };
});

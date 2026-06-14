/* =========================================================================
   GAMMA · Traduction FR — logique applicative (vanilla JS, zéro dépendance)
   Aucun stockage local : le mot de passe admin ne vit qu'en mémoire et part
   avec chaque requête vers le Cloudflare Worker.
   ========================================================================= */
(function () {
  "use strict";

  // ---- état --------------------------------------------------------------
  var config = {
    worker_url: "", site_title: "GAMMAFR", site_tagline: "",
    patch_base: "PatchVF",
    fra_path: "gamedata/configs/text/fra",
    mod_zip_name: "GAMMAFR-PatchVF"
  };
  var loaded = { files: false, liste: false, changelog: false, admin: false };

  // configurateur d'installation (piloté par data/patches.json, généré)
  var manifest = null;
  var conf = { level: null, selected: {}, step: 0 };

  // session admin (en mémoire uniquement) + cache des données éditables
  var admin = { pwd: "", unlocked: false };
  var data = { liste: null, changelog: null };

  // ---- petits utilitaires ------------------------------------------------
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === "class") node.className = props[k];
        else if (k === "text") node.textContent = props[k];
        else if (k === "html") node.innerHTML = props[k];
        else if (k.indexOf("on") === 0 && typeof props[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), props[k]);
        } else if (props[k] !== null && props[k] !== undefined) {
          node.setAttribute(k, props[k]);
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " sur " + url);
      return r.json();
    });
  }

  // ---- amorçage ----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    setupTabs();
    setupContact();
    loadConfig();
    // l'onglet Files est actif par défaut
    activateTab("files");
  });

  function loadConfig() {
    fetchJSON("data/config.json")
      .then(function (cfg) {
        config = Object.assign(config, cfg);
        if (config.site_title) {
          document.title = config.site_title;
          $("#brandTitle").textContent = config.site_title;
        }
        if (config.site_tagline) $("#brandTag").textContent = config.site_tagline;
      })
      .catch(function () { /* placeholders restent affichés */ });
  }

  // ---- navigation par onglets -------------------------------------------
  function setupTabs() {
    $all(".nav__btn").forEach(function (btn) {
      btn.addEventListener("click", function () { activateTab(btn.getAttribute("data-tab")); });
    });
  }

  function activateTab(name) {
    $all(".nav__btn").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-tab") === name);
    });
    $all(".panel").forEach(function (p) {
      p.classList.toggle("is-active", p.id === "panel-" + name);
    });
    if (name === "files" && !loaded.files) loadFiles();
    if (name === "liste") loadListe();
    if (name === "changelog") loadChangelog();
    if (name === "admin") loadAdmin();
  }

  /* =======================================================================
     ONGLET FILES — lisez-moi + Configurateur d'installation
     Piloté par data/patches.json (généré). Assemble un ZIP côté navigateur,
     résout les conflits par priorité, range la sélection dans fra/.
     ======================================================================= */
  function loadFiles() {
    loaded.files = true;
    var briefing = $("#briefing");
    var host = $("#wizard");

    // lisez-moi (optionnel)
    fetch("data/files.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (info) { briefing.textContent = (info && info.readme) || ""; });

    // structure des patchs
    fetchJSON("data/patches.json")
      .then(function (data) {
        manifest = normalizeManifest(data);
        conf = { level: null, selected: {}, step: 0 };
        renderConfigurator();
      })
      .catch(function (e) {
        clear(host);
        host.appendChild(el("p", { class: "list-empty", text:
          "Configurateur indisponible : data/patches.json introuvable ou invalide (" + e.message + ")." }));
      });
  }

  function normalizeManifest(d) {
    d = d || {};
    return {
      base: { files: (d.base && d.base.files) || [] },
      tweak: Array.isArray(d.tweak) ? d.tweak : [],
      extra: Array.isArray(d.extra) ? d.extra : [],
      mainfile: { files: (d.mainfile && d.mainfile.files) || [] }
    };
  }

  // ---- modèle -------------------------------------------------------------
  var LEVELS = [
    { id: "base",  label: "GAMMA base",  desc: "Uniquement la traduction de base, aucun patch." },
    { id: "tweak", label: "GAMMA tweak", desc: "Base incluse + choix parmi les patchs Tweak." },
    { id: "extra", label: "GAMMA extra", desc: "Base incluse + choix parmi les patchs Tweak et Extra." }
  ];

  function tagSection(section) {
    return function (p) { var c = Object.assign({}, p); c._section = section; return c; };
  }
  function availablePatches(level) {
    if (!manifest) return [];
    if (level === "tweak") return manifest.tweak.map(tagSection("Tweak"));
    if (level === "extra") return manifest.tweak.map(tagSection("Tweak")).concat(manifest.extra.map(tagSection("Extra")));
    return [];
  }
  function stepNames() {
    if (conf.level === "tweak" || conf.level === "extra") return ["Niveau", "Patchs", "Récapitulatif"];
    if (conf.level === "base") return ["Niveau", "Récapitulatif"];
    return ["Niveau"];
  }
  function baseName(path) { var p = String(path).split("/"); return p[p.length - 1]; }
  function encPath(path) { return String(path).split("/").map(encodeURIComponent).join("/"); }

  // ---- rendu --------------------------------------------------------------
  function renderConfigurator() {
    var host = $("#wizard");
    clear(host);

    var names = stepNames();
    if (conf.step >= names.length) conf.step = names.length - 1;

    host.appendChild(renderStepMarkers(names));

    var card = el("div", { class: "card" });
    var cur = names[conf.step];
    if (cur === "Niveau") card.appendChild(renderLevelStep());
    else if (cur === "Patchs") card.appendChild(renderPatchStep());
    else card.appendChild(renderRecapStep());
    host.appendChild(card);

    host.appendChild(renderActions(names));
  }

  function renderStepMarkers(names) {
    var bar = el("div", { class: "steps" });
    names.forEach(function (name, i) {
      var state = i === conf.step ? "is-current" : (i < conf.step ? "is-done" : "");
      bar.appendChild(el("div", { class: "step-node " + state }, [
        el("span", { class: "step-node__num", text: pad(i + 1) }),
        el("span", { text: name })
      ]));
      if (i < names.length - 1) bar.appendChild(el("span", { class: "step-line" }));
    });
    return bar;
  }

  function renderLevelStep() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("div", { class: "step-head" }, [el("h3", { class: "step-title", text: "Niveau d'installation" })]));
    frag.appendChild(el("p", { class: "step-sub", text: "Chaque niveau supérieur inclut automatiquement le contenu de GAMMA base." }));

    var box = el("div", { class: "options" });
    LEVELS.forEach(function (lv) {
      var checked = conf.level === lv.id;
      var count = lv.id === "tweak" ? manifest.tweak.length
                : lv.id === "extra" ? (manifest.tweak.length + manifest.extra.length) : 0;
      var sub = lv.desc + (lv.id !== "base" ? " (" + count + " patch" + (count > 1 ? "s" : "") + " dispo)" : "");
      var row = el("div", {
        class: "opt" + (checked ? " is-checked" : ""), "data-type": "single",
        role: "radio", "aria-checked": checked ? "true" : "false", tabindex: "0"
      }, [
        el("span", { class: "opt__mark" }),
        el("div", { class: "opt__body" }, [
          el("div", { class: "opt__label", text: lv.label }),
          el("div", { class: "opt__desc", text: sub })
        ])
      ]);
      var pick = function () {
        conf.level = lv.id;
        if (lv.id === "base") conf.selected = {};
        renderConfigurator();
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", function (ev) { if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); pick(); } });
      box.appendChild(row);
    });
    frag.appendChild(box);
    return frag;
  }

  function renderPatchStep() {
    var frag = document.createDocumentFragment();
    var patches = availablePatches(conf.level);

    frag.appendChild(el("div", { class: "step-head" }, [el("h3", { class: "step-title", text: "Patchs" })]));
    frag.appendChild(el("p", { class: "step-sub", text: "Coche les patchs à inclure. GAMMA base est déjà incluse." }));

    var input = el("input", { class: "input", type: "search", placeholder: "Filtrer les patchs\u2026", "aria-label": "Filtrer les patchs" });
    var count = el("div", { class: "search__count" });
    frag.appendChild(el("div", { class: "search" }, [el("span", { class: "search__icon", text: "\u2315" }), input, count]));

    var listBox = el("div", { class: "options" });
    frag.appendChild(listBox);

    if (!patches.length) {
      listBox.appendChild(el("p", { class: "list-empty", text: "Aucun patch disponible dans ce niveau." }));
      count.textContent = "0 / 0";
      return frag;
    }

    function paint(q) {
      clear(listBox);
      var needle = (q || "").toLowerCase().trim();
      var shown = 0;
      patches.forEach(function (p) {
        var hay = ((p.name || "") + " " + (p.description || "") + " " + (p.id || "")).toLowerCase();
        if (needle && hay.indexOf(needle) === -1) return;
        shown++;
        listBox.appendChild(renderPatchRow(p));
      });
      if (!shown) listBox.appendChild(el("div", { class: "list-empty", text: "Aucun patch ne correspond." }));
      count.textContent = shown + " / " + patches.length;
    }
    input.addEventListener("input", function () { paint(input.value); });
    paint("");
    return frag;
  }

  function renderPatchRow(p) {
    var checked = !!conf.selected[p.id];
    var meta = [];
    if (p.version) meta.push("v" + p.version);
    if (p.date) meta.push(p.date);
    meta.push("priorité " + (Number(p.priority) || 0));

    var label = el("div", { class: "opt__label" }, [
      document.createTextNode(p.name || p.id),
      el("span", { class: "opt__tag", text: p._section })
    ]);
    var bodyChildren = [label, el("div", { class: "opt__meta", text: meta.join("  \u00b7  ") })];
    if (p.description) bodyChildren.push(el("div", { class: "opt__desc", text: p.description }));
    if (p.url) bodyChildren.push(el("a", { class: "opt__link", href: p.url, target: "_blank", rel: "noopener noreferrer", text: "\u2197 page du mod" }));

    var row = el("div", {
      class: "opt" + (checked ? " is-checked" : ""), "data-type": "multi",
      role: "checkbox", "aria-checked": checked ? "true" : "false", tabindex: "0"
    }, [el("span", { class: "opt__mark" }), el("div", { class: "opt__body" }, bodyChildren)]);

    var toggle = function (ev) {
      if (ev && ev.target && ev.target.classList && ev.target.classList.contains("opt__link")) return;
      if (conf.selected[p.id]) delete conf.selected[p.id]; else conf.selected[p.id] = true;
      var on = !!conf.selected[p.id];
      row.classList.toggle("is-checked", on);
      row.setAttribute("aria-checked", on ? "true" : "false");
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", function (ev) { if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(); } });
    return row;
  }

  function renderRecapStep() {
    var r = resolveSelection();
    var frag = document.createDocumentFragment();
    frag.appendChild(el("h3", { class: "step-title", text: "Récapitulatif" }));
    frag.appendChild(el("p", { class: "step-sub", text: "Vérifie la sélection, puis génère l'archive d'installation." }));

    var recap = el("div", { class: "recap" });

    var lvLabel = (LEVELS.filter(function (l) { return l.id === r.level; })[0] || {}).label || "\u2014";
    recap.appendChild(el("div", { class: "recap__group" }, [
      el("div", { class: "recap__h", text: "Niveau" }),
      el("div", { class: "recap__item", text: lvLabel })
    ]));

    var pg = el("div", { class: "recap__group" }, [el("div", { class: "recap__h", text: "Patchs sélectionnés" })]);
    if (r.patches.length) {
      var ul = el("ul", { class: "recap__list" });
      r.patches.forEach(function (p) { ul.appendChild(el("li", { class: "recap__item", text: (p.name || p.id) + (p.version ? " \u00b7 v" + p.version : "") })); });
      pg.appendChild(ul);
    } else { pg.appendChild(el("div", { class: "recap__empty", text: "Aucun (base seule)" })); }
    recap.appendChild(pg);

    var fg = el("div", { class: "recap__group" }, [el("div", { class: "recap__h", text: "Fichiers générés (" + r.files.length + ")" })]);
    var fl = el("ul", { class: "recap__list" });
    r.files.forEach(function (f) {
      var line = el("li", { class: "recap__file" + (f.conflict ? " is-conflict" : "") }, [
        el("span", { class: "recap__fname", text: f.name }),
        el("span", { class: "recap__src", text: "\u2190 " + f.winner.label })
      ]);
      if (f.conflict) {
        var others = f.contenders.filter(function (c) { return c.priority === f.winner.priority; }).map(function (c) { return c.label; }).join(", ");
        line.appendChild(el("span", { class: "recap__warn", title: "Priorité identique : " + others + ". Gagnant déterministe \u2014 fixe des priorités distinctes pour lever l'ambiguïté.", text: "\u26A0 conflit" }));
      }
      fl.appendChild(line);
    });
    fg.appendChild(fl);
    recap.appendChild(fg);

    if (r.mainfile.length) {
      recap.appendChild(el("div", { class: "recap__group" }, [
        el("div", { class: "recap__h", text: "Structure (MainFile)" }),
        el("div", { class: "recap__item", text: r.mainfile.length + " fichier(s) inclus tels quels" })
      ]));
    }
    if (r.warnings.length) {
      recap.appendChild(el("div", { class: "notice is-shown notice--err", text: r.warnings.length + " conflit(s) de priorité \u2014 voir \u26A0 ci-dessus." }));
    }

    frag.appendChild(recap);
    frag.appendChild(el("div", { id: "dlZone" }));
    return frag;
  }

  // ---- résolution par priorité -------------------------------------------
  function resolveSelection() {
    var level = conf.level;
    var chosen = availablePatches(level).filter(function (p) { return conf.selected[p.id]; });

    var map = {};
    function add(label, priority, files) {
      (files || []).forEach(function (path) {
        var b = baseName(path);
        (map[b] = map[b] || []).push({ path: path, label: label, priority: priority });
      });
    }
    add("GAMMA base", -Infinity, manifest.base.files);
    chosen.forEach(function (p) { add(p.name || p.id, Number(p.priority) || 0, p.files); });

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
    return { level: level, patches: chosen, files: files, warnings: warnings, mainfile: manifest.mainfile.files };
  }

  // ---- actions / navigation ----------------------------------------------
  function renderActions(names) {
    var actions = el("div", { class: "wizard-actions" });
    var back = el("button", { class: "btn btn--ghost", text: "\u25C2 Retour",
      onClick: function () { if (conf.step > 0) { conf.step--; renderConfigurator(); } } });
    back.disabled = conf.step === 0;
    actions.appendChild(back);

    if (names[conf.step] === "Récapitulatif") {
      actions.appendChild(el("button", { class: "btn", text: "Générer l'archive \u25BE", onClick: assembleAndDownload }));
    } else {
      var next = el("button", { class: "btn", text: "Suivant \u25B8",
        onClick: function () { conf.step++; renderConfigurator(); } });
      if (names[conf.step] === "Niveau") next.disabled = !conf.level;
      actions.appendChild(next);
    }
    return actions;
  }

  // ---- assemblage du ZIP --------------------------------------------------
  function assembleAndDownload() {
    var zone = $("#dlZone");
    if (!zone || !manifest) return;
    clear(zone);

    if (typeof window.GammaZip === "undefined") {
      zone.appendChild(el("p", { class: "notice is-shown notice--err", text: "Module ZIP non chargé (js/zip.js)." }));
      return;
    }

    var r = resolveSelection();
    var prefix = (config.patch_base || "PatchVF") + "/MainFile/";
    var targets = {}; // cible dans le zip -> chemin source
    r.mainfile.forEach(function (path) {
      var target = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : baseName(path);
      targets[target] = path;
    });
    r.files.forEach(function (f) {
      targets[(config.fra_path || "gamedata/configs/text/fra") + "/" + f.name] = f.winner.path;
    });

    var list = Object.keys(targets);
    var total = list.length;
    if (!total) { zone.appendChild(el("p", { class: "recap__empty", text: "Rien à générer." })); return; }

    var bar = el("div", { class: "progress__bar" });
    zone.appendChild(el("div", { class: "progress" }, [bar]));
    var status = el("p", { class: "notice is-shown", text: "Téléchargement des fichiers\u2026 0 / " + total });
    zone.appendChild(status);

    var entries = [], done = 0, failed = [];
    function step(i) {
      if (i >= total) return finish();
      var target = list[i], src = targets[target];
      return fetch(encPath(src), { cache: "no-store" })
        .then(function (resp) { if (!resp.ok) throw new Error("HTTP " + resp.status); return resp.arrayBuffer(); })
        .then(function (ab) { entries.push({ name: target, data: new Uint8Array(ab) }); })
        .catch(function () { failed.push(src); })
        .then(function () {
          done++;
          bar.style.width = Math.round((done / total) * 100) + "%";
          status.textContent = "Téléchargement des fichiers\u2026 " + done + " / " + total;
          return step(i + 1);
        });
    }

    function finish() {
      if (failed.length) {
        status.className = "notice is-shown notice--err";
        status.textContent = failed.length + " fichier(s) introuvable(s). Vérifie que PatchVF est publié sur le site. Premier échec : " + failed[0];
        return;
      }
      status.textContent = "Compression\u2026";
      window.GammaZip.create(entries).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var name = (config.mod_zip_name || "GAMMAFR-PatchVF") + ".zip";
        var a = el("a", { href: url, download: name });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
        status.className = "notice is-shown notice--ok";
        clear(status);
        status.appendChild(document.createTextNode("Archive prête : "));
        status.appendChild(el("a", { href: url, download: name, class: "dl__relink", text: name }));
        status.appendChild(document.createTextNode("  (" + total + " fichiers)."));
      }).catch(function (e) {
        status.className = "notice is-shown notice--err";
        status.textContent = "Échec de la compression : " + e.message;
      });
    }

    step(0);
  }

  /* =======================================================================
     ONGLET LISTE — lecture filtrable + édition admin en place
     ======================================================================= */
  function loadListe() {
    var host = $("#listeHost");
    if (data.liste !== null) { renderListe(); return; }
    fetchJSON("data/liste.json")
      .then(function (entries) { data.liste = Array.isArray(entries) ? entries : []; renderListe(); })
      .catch(function (e) {
        clear(host);
        host.appendChild(el("p", { class: "list-empty", text: "Impossible de charger la liste (" + e.message + ")." }));
      });
  }

  function renderListe() {
    if (isAdmin()) renderListeEditor();
    else renderListeReadonly();
  }

  function renderListeReadonly() {
    var host = $("#listeHost");
    clear(host);
    var entries = data.liste || [];

    var input = el("input", { class: "input", type: "search", placeholder: "Filtrer par titre ou description\u2026", "aria-label": "Rechercher" });
    var icon = el("span", { class: "search__icon", text: "\u2315" });
    var count = el("div", { class: "search__count" });
    host.appendChild(el("div", { class: "search" }, [icon, input, count]));

    var listBox = el("div", { class: "list" });
    host.appendChild(listBox);

    function paint(q) {
      clear(listBox);
      var needle = (q || "").toLowerCase().trim();
      var shown = 0;
      entries.forEach(function (it) {
        var hay = ((it.title || "") + " " + (it.description || "")).toLowerCase();
        if (needle && hay.indexOf(needle) === -1) return;
        shown++;
        listBox.appendChild(el("div", { class: "list-item" }, [
          el("div", { class: "list-item__num", text: pad(it.id != null ? it.id : shown) }),
          el("div", { class: "list-item__body" }, [
            el("div", { class: "list-item__title", text: it.title || "" }),
            it.description ? el("div", { class: "list-item__desc", text: it.description }) : null
          ])
        ]));
      });
      if (!shown) listBox.appendChild(el("div", { class: "list-empty", text: "Aucune entrée ne correspond." }));
      count.textContent = shown + " / " + entries.length + " entrée" + (entries.length > 1 ? "s" : "");
    }
    input.addEventListener("input", function () { paint(input.value); });
    paint("");
  }

  function renderListeEditor() {
    var host = $("#listeHost");
    clear(host);
    var draft = (data.liste || []).map(function (e) { return { title: e.title || "", description: e.description || "" }; });

    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition de la liste — n'oublie pas d'enregistrer." })
    ]));

    var rows = el("div", { class: "editrows" });
    host.appendChild(rows);

    function drawRows() {
      clear(rows);
      draft.forEach(function (entry, i) {
        var title = el("input", { class: "input", type: "text", value: entry.title, placeholder: "Titre (ex. st_dialogs.xml)" });
        title.addEventListener("input", function () { entry.title = title.value; });
        var desc = el("input", { class: "input", type: "text", value: entry.description, placeholder: "Description (optionnel)" });
        desc.addEventListener("input", function () { entry.description = desc.value; });
        var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "\u2715",
          onClick: function () { draft.splice(i, 1); drawRows(); } });
        rows.appendChild(el("div", { class: "editrow" }, [
          el("span", { class: "editrow__num", text: pad(i + 1) }),
          el("div", { class: "editrow__fields" }, [title, desc]),
          del
        ]));
      });
      if (!draft.length) rows.appendChild(el("p", { class: "list-empty", text: "Liste vide. Ajoute une entrée." }));
    }
    drawRows();

    var add = el("button", { class: "btn btn--ghost", text: "+ Ajouter une entrée",
      onClick: function () { draft.push({ title: "", description: "" }); drawRows(); } });
    var save = el("button", { class: "btn btn--amber", text: "Enregistrer la liste" });
    var status = el("span", { class: "editor__status" });
    save.addEventListener("click", function () {
      var clean = draft
        .filter(function (e) { return (e.title || "").trim() !== ""; })
        .map(function (e, i) { return { id: i + 1, title: e.title.trim(), description: (e.description || "").trim() }; });
      saveData("liste.json", clean, status, save, function () { data.liste = clean; });
    });
    host.appendChild(el("div", { class: "editor__foot" }, [add, save, status]));
  }

  /* =======================================================================
     ONGLET CHANGELOG — lecture (versions décroissantes) + édition admin
     ======================================================================= */
  function loadChangelog() {
    var host = $("#logHost");
    if (data.changelog !== null) { renderChangelog(); return; }
    fetchJSON("data/changelog.json")
      .then(function (entries) { data.changelog = Array.isArray(entries) ? entries : []; renderChangelog(); })
      .catch(function (e) {
        clear(host);
        host.appendChild(el("p", { class: "list-empty", text: "Impossible de charger le changelog (" + e.message + ")." }));
      });
  }

  function renderChangelog() {
    if (isAdmin()) renderChangelogEditor();
    else renderChangelogReadonly();
  }

  function renderChangelogReadonly() {
    var host = $("#logHost");
    clear(host);
    var entries = (data.changelog || []).slice().sort(function (a, b) { return cmpVersion(b.version, a.version); });
    if (!entries.length) { host.appendChild(el("p", { class: "list-empty", text: "Aucune entrée." })); return; }

    var box = el("div", { class: "log" });
    entries.forEach(function (e) {
      var head = el("div", { class: "log-entry__head" }, [
        el("span", { class: "log-entry__ver", text: "v" + (e.version || "?") }),
        e.date ? el("span", { class: "log-entry__date", text: e.date }) : null
      ]);
      var ul = el("ul", { class: "log-entry__changes" });
      (e.changes || []).forEach(function (c) { ul.appendChild(el("li", { text: c })); });
      box.appendChild(el("div", { class: "log-entry" }, [head, ul]));
    });
    host.appendChild(box);
  }

  function renderChangelogEditor() {
    var host = $("#logHost");
    clear(host);
    var draft = (data.changelog || []).map(function (e) {
      return { version: e.version || "", date: e.date || "", changes: (e.changes || []).slice() };
    });

    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition du changelog — n'oublie pas d'enregistrer." })
    ]));

    var rows = el("div", { class: "editrows" });
    host.appendChild(rows);

    function drawRows() {
      clear(rows);
      draft.forEach(function (entry, i) {
        var ver = el("input", { class: "input input--sm", type: "text", value: entry.version, placeholder: "Version (1.2.0)" });
        ver.addEventListener("input", function () { entry.version = ver.value; });
        var date = el("input", { class: "input input--sm", type: "text", value: entry.date, placeholder: "Date (2026-06-14)" });
        date.addEventListener("input", function () { entry.date = date.value; });
        var delV = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer la version", text: "\u2715",
          onClick: function () { draft.splice(i, 1); drawRows(); } });

        var lines = el("div", { class: "editlines" });
        (function (entry) {
          function drawLines() {
            clear(lines);
            entry.changes.forEach(function (c, j) {
              var line = el("input", { class: "input", type: "text", value: c, placeholder: "Modification\u2026" });
              line.addEventListener("input", function () { entry.changes[j] = line.value; });
              var delC = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer la ligne", text: "\u2715",
                onClick: function () { entry.changes.splice(j, 1); drawLines(); } });
              lines.appendChild(el("div", { class: "editline" }, [line, delC]));
            });
            lines.appendChild(el("button", { class: "btn btn--ghost btn--mini", text: "+ ligne",
              onClick: function () { entry.changes.push(""); drawLines(); } }));
          }
          drawLines();
        })(entry);

        rows.appendChild(el("div", { class: "editcard" }, [
          el("div", { class: "editcard__head" }, [ver, date, delV]),
          lines
        ]));
      });
      if (!draft.length) rows.appendChild(el("p", { class: "list-empty", text: "Aucune version. Ajoutes-en une." }));
    }
    drawRows();

    var add = el("button", { class: "btn btn--ghost", text: "+ Ajouter une version",
      onClick: function () { draft.unshift({ version: "", date: "", changes: [""] }); drawRows(); } });
    var save = el("button", { class: "btn btn--amber", text: "Enregistrer le changelog" });
    var status = el("span", { class: "editor__status" });
    save.addEventListener("click", function () {
      var clean = draft
        .filter(function (e) { return (e.version || "").trim() !== ""; })
        .map(function (e) {
          return {
            version: e.version.trim(),
            date: (e.date || "").trim(),
            changes: e.changes.map(function (c) { return (c || "").trim(); }).filter(Boolean)
          };
        });
      saveData("changelog.json", clean, status, save, function () { data.changelog = clean; });
    });
    host.appendChild(el("div", { class: "editor__foot" }, [add, save, status]));
  }

  function cmpVersion(a, b) {
    var pa = String(a || "").split(".").map(Number);
    var pb = String(b || "").split(".").map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /* =======================================================================
     ONGLET CONTACT — message envoyé au Worker (stockage KV), sans email
     ======================================================================= */
  function setupContact() {
    var btn = $("#contactSend");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var pseudo = $("#cName").value.trim();
      var motif = $("#cMotif").value;
      var objet = $("#cObjet").value.trim();
      var message = $("#cMessage").value.trim();
      var notice = $("#contactNotice");
      notice.className = "notice";

      if (!objet || !message) {
        showNotice(notice, "err", "Renseigne l'objet et le message (le pseudo est facultatif).");
        return;
      }
      if (!workerReady()) {
        showNotice(notice, "err", "Envoi indisponible : le Worker n'est pas encore configuré.");
        return;
      }

      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = "Envoi\u2026";

      fetch(config.worker_url.replace(/\/$/, "") + "/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pseudo: pseudo, motif: motif, objet: objet, message: message })
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (res) {
          if (res.ok && res.data && res.data.success) {
            showNotice(notice, "ok", "Message envoyé. Merci !");
            $("#cName").value = ""; $("#cObjet").value = ""; $("#cMessage").value = ""; $("#cMotif").value = "Suggestion";
          } else if (res.status === 429) {
            showNotice(notice, "err", "Trop de messages envoyés. Réessaie plus tard.");
          } else {
            showNotice(notice, "err", (res.data && res.data.error) || "Échec de l'envoi. Réessaie plus tard.");
          }
        })
        .catch(function () { showNotice(notice, "err", "Réseau indisponible. Réessaie plus tard."); })
        .then(function () { btn.disabled = false; btn.textContent = prev; });
    });
  }

  function showNotice(node, kind, text) {
    node.className = "notice is-shown notice--" + (kind === "ok" ? "ok" : "err");
    node.textContent = text;
  }

  /* =======================================================================
     ONGLET ADMIN — déverrouillage + formulaires (config, lisez-moi)
     Tout est masqué tant que le mot de passe n'est pas saisi puis déverrouillé.
     Le mot de passe ne vit qu'en mémoire et part avec chaque enregistrement.
     Liste et Changelog s'éditent directement dans leurs onglets.
     ======================================================================= */
  function isAdmin() { return admin.unlocked && !!admin.pwd; }

  function loadAdmin() { renderAdmin(); }

  function lockAdmin() { admin.unlocked = false; admin.pwd = ""; renderAdmin(); }

  function workerReady() {
    return !!config.worker_url && config.worker_url.indexOf("VOTRE-SOUS-DOMAINE") === -1;
  }

  function renderAdmin() {
    var host = $("#adminRoot");
    if (!host) return;
    clear(host);

    host.appendChild(el("div", { class: "admin-warn" }, [
      el("span", { class: "admin-warn__tag", text: "PRIVÉ" }),
      el("span", { text: "Le mot de passe n'est jamais stocké : il est vérifié par le Worker à la connexion et à chaque enregistrement." })
    ]));

    if (!workerReady()) { host.appendChild(renderAdminNoWorker()); return; }
    if (isAdmin()) { host.appendChild(renderAdminUnlocked()); loadMessages(); }
    else host.appendChild(renderAdminLock());
  }

  function renderAdminNoWorker() {
    var card = el("div", { class: "card" });
    card.appendChild(el("p", { class: "admin-note", text:
      "L'administration nécessite le Cloudflare Worker : c'est lui qui vérifie le mot de passe et écrit les modifications sur GitHub (le navigateur seul n'en a pas le droit). Tant qu'il n'est pas configuré, la connexion est impossible." }));
    var ol = el("ol", { class: "admin-steps" });
    ["Déploie worker.js sur Cloudflare (Worker « Hello World »).",
     "Ajoute les variables : ADMIN_PASSWORD (Secret), GITHUB_TOKEN (Secret), GITHUB_OWNER, GITHUB_REPO, ALLOWED_ORIGIN.",
     "Renseigne worker_url dans data/config.json avec l'URL du Worker (sans /update)."
    ].forEach(function (t) { ol.appendChild(el("li", { text: t })); });
    card.appendChild(ol);
    return card;
  }

  function renderAdminLock() {
    var wrap = el("div", {});
    var card = el("div", { class: "card" });
    var pwd = el("input", { class: "input", id: "adminPwd", type: "password", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", autocomplete: "off" });
    var note = el("div", { class: "notice" });
    var loginBtn = el("button", { class: "btn", text: "Se connecter" });

    function tryUnlock() {
      var pw = pwd.value;
      if (!pw) { showNotice(note, "err", "Saisis le mot de passe."); return; }
      loginBtn.disabled = true;
      note.className = "notice is-shown"; note.textContent = "Vérification\u2026";
      fetch(config.worker_url.replace(/\/$/, "") + "/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw })
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
        .then(function (res) {
          if (res.ok && res.data && res.data.success) { admin.pwd = pw; admin.unlocked = true; renderAdmin(); }
          else if (res.status === 401) { showNotice(note, "err", (res.data && res.data.error) || "Mot de passe refusé."); }
          else if (res.status === 429) { showNotice(note, "err", "Trop de tentatives. Réessaie plus tard."); }
          else { showNotice(note, "err", (res.data && res.data.error) || ("Échec (HTTP " + res.status + ")")); }
        })
        .catch(function () { showNotice(note, "err", "Worker injoignable. Vérifie son URL et son déploiement."); })
        .then(function () { loginBtn.disabled = false; });
    }
    loginBtn.addEventListener("click", tryUnlock);
    pwd.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); tryUnlock(); } });

    card.appendChild(el("label", { class: "field", style: "margin-bottom:0" }, [
      el("span", { class: "field__label", text: "Mot de passe admin" }), pwd
    ]));
    wrap.appendChild(card);
    wrap.appendChild(el("div", { class: "admin-actions" }, [loginBtn]));
    wrap.appendChild(note);
    return wrap;
  }

  function renderAdminUnlocked() {
    var wrap = el("div", {});

    wrap.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "CONNECTÉ" }),
      el("span", { text: "Tu peux aussi modifier la Liste et le Changelog dans leurs onglets." }),
      el("button", { class: "btn btn--ghost btn--mini", text: "Verrouiller", onClick: lockAdmin })
    ]));

    // ---- configuration du site ----
    wrap.appendChild(el("div", { class: "stencil stencil--muted", text: "Configuration du site" }));
    var cfgCard = el("div", { class: "card" });
    var fields = [
      { key: "site_title", label: "Titre du site" },
      { key: "site_tagline", label: "Sous-titre" },
      { key: "worker_url", label: "URL du Worker" },
      { key: "patch_base", label: "Dossier des patchs" },
      { key: "fra_path", label: "Chemin d'installation (fra)" },
      { key: "mod_zip_name", label: "Nom de l'archive (.zip)" }
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var inp = el("input", { class: "input", type: "text", value: config[f.key] != null ? config[f.key] : "" });
      inputs[f.key] = inp;
      cfgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: f.label }), inp]));
    });
    var cfgStatus = el("span", { class: "editor__status" });
    var cfgSave = el("button", { class: "btn btn--amber", text: "Enregistrer la configuration" });
    cfgSave.addEventListener("click", function () {
      var obj = {};
      fields.forEach(function (f) { obj[f.key] = inputs[f.key].value.trim(); });
      saveData("config.json", obj, cfgStatus, cfgSave, function () {
        config = Object.assign(config, obj);
        if (config.site_title) { document.title = config.site_title; $("#brandTitle").textContent = config.site_title; }
        if (config.site_tagline) $("#brandTag").textContent = config.site_tagline;
      });
    });
    cfgCard.appendChild(el("div", { class: "editor__foot" }, [cfgSave, cfgStatus]));
    wrap.appendChild(cfgCard);

    // ---- texte du lisez-moi (onglet Files) ----
    wrap.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Texte du lisez-moi (onglet Files)" }));
    var rmCard = el("div", { class: "card" });
    var rm = el("textarea", { class: "textarea", rows: "8", placeholder: "Texte affiché en haut de l'onglet Files\u2026" });
    rm.value = "Chargement\u2026"; rm.disabled = true;
    fetch("data/files.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (info) { rm.value = (info && info.readme) || ""; rm.disabled = false; })
      .catch(function () { rm.value = ""; rm.disabled = false; });
    var rmStatus = el("span", { class: "editor__status" });
    var rmSave = el("button", { class: "btn btn--amber", text: "Enregistrer le lisez-moi" });
    rmSave.addEventListener("click", function () { saveData("files.json", { readme: rm.value }, rmStatus, rmSave); });
    rmCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Contenu" }), rm]));
    rmCard.appendChild(el("div", { class: "editor__foot" }, [rmSave, rmStatus]));
    wrap.appendChild(rmCard);

    // ---- messages reçus (contact) ----
    wrap.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Messages reçus" }));
    var inboxCard = el("div", { class: "card" });
    inboxCard.appendChild(el("div", { class: "inbox__head" }, [
      el("span", { class: "inbox__title", text: "Boîte de réception" }),
      el("button", { class: "btn btn--ghost btn--mini", text: "Rafraîchir", onClick: loadMessages })
    ]));
    inboxCard.appendChild(el("div", { id: "adminInbox" }, [el("span", { class: "loading", text: "Chargement\u2026" })]));
    wrap.appendChild(inboxCard);

    return wrap;
  }

  // ---- enregistrement générique vers le Worker ---------------------------
  function saveData(filename, obj, status, btn, onSuccess) {
    if (!isAdmin()) { setStatus(status, "err", "Session admin verrouillée."); return; }
    if (!config.worker_url || config.worker_url.indexOf("VOTRE-SOUS-DOMAINE") !== -1) {
      setStatus(status, "err", "worker_url non configuré dans data/config.json."); return;
    }
    var content = JSON.stringify(obj, null, 2) + "\n";
    if (btn) btn.disabled = true;
    setStatus(status, "work", "Envoi vers le Worker\u2026");

    fetch(config.worker_url.replace(/\/$/, "") + "/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin.pwd, filename: filename, content: content })
    })
      .then(function (r) {
        return r.json().catch(function () { return { error: "Réponse illisible (HTTP " + r.status + ")" }; })
          .then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
      })
      .then(function (res) {
        if (res.ok && res.data && res.data.success) {
          setStatus(status, "ok", "Enregistré. Le site se met à jour sous peu (cache GitHub Pages).");
          if (typeof onSuccess === "function") onSuccess();
        } else if (res.status === 401) {
          setStatus(status, "err", "Session expirée. Reconnecte-toi dans l'onglet Admin.");
          admin.unlocked = false; admin.pwd = "";
        } else if (res.status === 429) {
          setStatus(status, "err", "Trop de tentatives. Réessaie dans quelques minutes.");
        } else {
          setStatus(status, "err", (res.data && res.data.error) || ("Échec (HTTP " + res.status + ")"));
        }
      })
      .catch(function () { setStatus(status, "err", "Worker injoignable. Vérifie l'URL et le déploiement."); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  // ---- boîte de réception (messages de contact) --------------------------
  function loadMessages() {
    var host = $("#adminInbox");
    if (!host) return;
    clear(host); host.appendChild(el("span", { class: "loading", text: "Chargement\u2026" }));
    fetch(config.worker_url.replace(/\/$/, "") + "/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin.pwd, action: "list" })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.ok && res.data && res.data.messages) renderMessages(res.data.messages);
        else if (res.status === 401) { admin.unlocked = false; admin.pwd = ""; renderAdmin(); }
        else renderMessagesError((res.data && res.data.error) || "Impossible de charger les messages.");
      })
      .catch(function () { renderMessagesError("Worker injoignable."); });
  }

  function renderMessages(list) {
    var host = $("#adminInbox");
    if (!host) return;
    clear(host);
    if (!list.length) { host.appendChild(el("p", { class: "list-empty", text: "Aucun message pour le moment." })); return; }
    host.appendChild(el("div", { class: "inbox__count", text: list.length + " message" + (list.length > 1 ? "s" : "") }));
    list.forEach(function (m) {
      var motif = m.motif || "Autre";
      var head = el("div", { class: "msg__head" }, [
        el("span", { class: "msg__motif msg__motif--" + motif.toLowerCase(), text: motif }),
        el("span", { class: "msg__objet", text: m.objet || "(sans objet)" }),
        el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "\u2715", onClick: function () { deleteMessage(m.key); } })
      ]);
      var meta = el("div", { class: "msg__meta", text: (m.pseudo ? m.pseudo : "anonyme") + " \u00b7 " + fmtDate(m.date) });
      host.appendChild(el("div", { class: "msg" }, [head, meta, el("div", { class: "msg__body", text: m.message || "" })]));
    });
  }

  function renderMessagesError(msg) {
    var host = $("#adminInbox");
    if (!host) return;
    clear(host);
    host.appendChild(el("p", { class: "notice is-shown notice--err", text: msg }));
  }

  function deleteMessage(key) {
    fetch(config.worker_url.replace(/\/$/, "") + "/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin.pwd, action: "delete", key: key })
    })
      .then(function () { loadMessages(); })
      .catch(function () { loadMessages(); });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function setStatus(node, kind, text) {
    node.className = "editor__status editor__status--" + kind;
    node.textContent = text;
  }

  // ---- divers ------------------------------------------------------------
  function pad(n) { n = Number(n) || 0; return (n < 10 ? "0" : "") + n; }

})();

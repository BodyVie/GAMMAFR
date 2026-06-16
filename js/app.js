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
    patch_base: "0. PatchVF",
    fra_path: "gamedata/configs/text/fra",
    mod_zip_name: "GAMMAFR-PatchVF"
  };
  var loaded = { files: false, liste: false, changelog: false, admin: false };
  var DEFAULT_TAB = "board";   // onglet d'accueil à l'ouverture

  // configurateur d'installation (piloté par data/patches.json, généré)
  var manifest = null;
  var conf = { level: null, selected: {}, step: 0 };

  // session admin (en mémoire uniquement) + cache des données éditables
  var admin = { pwd: "", unlocked: false };
  var data = { liste: null, changelog: null, planner: null, admins: null, board: null };

  // verrouillage optimiste : SHA GitHub de la version chargée pour chaque fichier
  var editSha = {};
  // présence (compteur d'admins en ligne) + indicateur « édition en cours »
  var presence = { id: null, timer: null };
  var adminDirty = false;
  // dernier auteur choisi pour un commentaire planner (mémoire de session)
  var lastAuthor = "";

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

  // Affiche un message d'erreur de chargement + un bouton « Réessayer » qui
  // relance la fonction de chargement passée en argument.
  function loadError(host, msg, retry) {
    clear(host);
    host.appendChild(el("div", { class: "load-error" }, [
      el("p", { class: "list-empty", text: msg }),
      el("button", { class: "btn btn--ghost", text: "↻ Réessayer", onClick: function () {
        clear(host);
        host.appendChild(el("span", { class: "loading", text: "Chargement…" }));
        retry();
      } })
    ]));
  }

  // ---- amorçage ----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    syncShareMeta();
    setupTabs();
    setupContact();
    loadConfig();
    // onglet initial : déduit du #hash de l'URL (partage / rechargement), sinon l'accueil
    var initial = tabFromHash() || DEFAULT_TAB;
    if (!tabFromHash() && history.replaceState) history.replaceState(null, "", "#" + initial);
    activateTab(initial);
    // bouton Précédent/Suivant du navigateur ⇄ onglet courant
    window.addEventListener("hashchange", function () { activateTab(tabFromHash() || DEFAULT_TAB); });

    // présence : signale le départ d'un admin, rafraîchit au retour d'onglet,
    // marque l'édition en cours dès qu'un champ admin est modifié.
    window.addEventListener("beforeunload", function () { if (isAdmin()) leavePresence(); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState !== "hidden") presenceTick(); });
    document.addEventListener("input", function (e) {
      if (!isAdmin() || !e.target || !e.target.closest) return;
      if (e.target.closest("#panel-admin, #listeHost, #logHost, #plannerHost, .modal")) markDirty();
    }, true);
  });

  // Aligne les balises de partage (canonical, Open Graph, Twitter) sur l'URL
  // réelle d'hébergement, dérivée d'une seule source (location). Évite d'avoir à
  // éditer index.html en plusieurs endroits si le domaine/chemin change ; les
  // valeurs codées dans le HTML ne servent plus que de repli pour les robots
  // qui n'exécutent pas JS.
  function syncShareMeta() {
    var dir = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, ""); // dossier courant (…/)
    var img = dir + "assets/og-image.png";
    [
      ['link[rel="canonical"]', "href", dir],
      ['meta[property="og:url"]', "content", dir],
      ['meta[property="og:image"]', "content", img],
      ['meta[name="twitter:image"]', "content", img]
    ].forEach(function (m) {
      var node = document.querySelector(m[0]);
      if (node) node.setAttribute(m[1], m[2]);
    });
  }

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
      .catch(function () { /* placeholders restent affichés */ })
      .then(function () { startPresence(); }); // compteur d'admins (public) une fois worker_url connu
  }

  /* ---- présence : compteur d'admins en ligne + indicateur d'édition -------
     Tout le monde lit le compteur (action "count", sans mot de passe) ; un admin
     connecté envoie un heartbeat (ping) avec son état « édition en cours ». */
  var PRESENCE_MS = 25000;

  function sessionId() {
    if (!presence.id) presence.id = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    return presence.id;
  }
  function presenceUrl() { return config.worker_url.replace(/\/$/, "") + "/presence"; }

  function presenceTick() {
    if (!workerReady()) return;
    var payload = isAdmin()
      ? { password: admin.pwd, id: sessionId(), action: "ping", editing: adminDirty }
      : { action: "count" };
    fetch(presenceUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        // Un admin connecté se compte toujours au moins lui-même : la liste KV
        // peut être à la traîne (latence) — voire renvoyer 0 si aucun KV n'est lié.
        var count = d.count || 0;
        if (isAdmin() && count < 1) count = 1;
        // « édition en cours » : visible si un autre admin édite (compté par le
        // Worker) OU si l'admin courant a lui-même une modification non enregistrée.
        var editing = (d.editing || 0) > 0 || (isAdmin() && adminDirty);
        setPresenceBadge(count, editing);
      })
      .catch(function () {});
  }

  function startPresence() {
    if (presence.timer) clearInterval(presence.timer);
    presenceTick();
    presence.timer = setInterval(function () {
      if (document.visibilityState !== "hidden") presenceTick();
    }, PRESENCE_MS);
  }

  function leavePresence() {
    if (!workerReady() || !presence.id || !admin.pwd) return;
    try {
      fetch(presenceUrl(), {
        method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
        body: JSON.stringify({ password: admin.pwd, id: presence.id, action: "leave" })
      });
    } catch (_) {}
  }

  function setPresenceBadge(count, editing) {
    var badge = $("#adminCount"), warn = $("#adminEditing");
    if (badge) {
      if (count > 0) { badge.textContent = count + " en ligne"; badge.hidden = false; }
      else badge.hidden = true;
    }
    if (warn) warn.hidden = !editing;
  }

  function markDirty() {
    if (adminDirty || !isAdmin()) return;
    adminDirty = true;
    presenceTick(); // propage immédiatement « édition en cours » aux autres
  }
  function clearDirty() {
    if (!adminDirty) return;
    adminDirty = false;
    presenceTick();
  }

  // Charge un fichier via le Worker : contenu autoritatif + SHA (jeton de version
  // pour le verrouillage optimiste). Mémorise le SHA dans editSha[filename].
  function loadForEdit(filename) {
    return fetch(config.worker_url.replace(/\/$/, "") + "/load", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin.pwd, filename: filename })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401) { lockAdmin(); throw new Error("Session verrouillée."); }
        if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
        editSha[filename] = (typeof d.sha === "string" || d.sha === null) ? d.sha : null;
        var obj = null;
        if (d.content && String(d.content).trim() !== "") { try { obj = JSON.parse(d.content); } catch (_) { obj = null; } }
        return { obj: obj, sha: editSha[filename] };
      });
    });
  }

  // Charge la liste des pseudos admin (fichier public) pour le sélecteur d'auteur.
  function loadAdmins() {
    return fetch("data/admins.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (a) { data.admins = Array.isArray(a) ? a.filter(function (x) { return typeof x === "string" && x.trim() !== ""; }) : []; })
      .catch(function () { data.admins = []; });
  }

  // ---- navigation par onglets -------------------------------------------
  function tabNames() {
    return $all(".nav__btn").map(function (b) { return b.getAttribute("data-tab"); });
  }
  function tabFromHash() {
    var h = (location.hash || "").replace(/^#/, "");
    return tabNames().indexOf(h) !== -1 ? h : null;
  }

  function setupTabs() {
    var btns = $all(".nav__btn");
    btns.forEach(function (btn, i) {
      btn.addEventListener("click", function () { navigateTab(btn.getAttribute("data-tab")); });
      // motif ARIA tabs : flèches / Home / End déplacent le focus et activent l'onglet
      btn.addEventListener("keydown", function (ev) {
        var idx = -1;
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") idx = (i + 1) % btns.length;
        else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") idx = (i - 1 + btns.length) % btns.length;
        else if (ev.key === "Home") idx = 0;
        else if (ev.key === "End") idx = btns.length - 1;
        else return;
        ev.preventDefault();
        btns[idx].focus();
        navigateTab(btns[idx].getAttribute("data-tab"));
      });
    });
  }

  // action utilisateur : passe par le #hash → l'historique permet Précédent/Suivant
  function navigateTab(name) {
    if ((tabFromHash() || DEFAULT_TAB) === name) { activateTab(name); return; }
    location.hash = name; // déclenche hashchange → activateTab
  }

  function activateTab(name) {
    $all(".nav__btn").forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    $all(".panel").forEach(function (p) {
      p.classList.toggle("is-active", p.id === "panel-" + name);
    });
    if (name === "board") loadBoard();
    if (name === "files" && !loaded.files) loadFiles();
    if (name === "liste") loadListe();
    if (name === "changelog") loadChangelog();
    if (name === "planner") loadPlanner();
    if (name === "admin") loadAdmin();
  }

  /* =======================================================================
     ONGLET PANNEAU D'AFFICHAGE — accueil
     En tête : un panneau d'annonce éditable par les admins (data/board.json).
     En dessous : les nouveautés, c.-à-d. toutes les modifications du dernier
     jour de modifications, déduites du changelog (data/changelog.json).
     ======================================================================= */
  function normalizeBoard(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
    return { title: String(o.title || ""), body: String(o.body || ""), updated: String(o.updated || "") };
  }

  function loadBoard() {
    var host = $("#boardHost");
    if (!host) return;
    clear(host);

    // 1) panneau d'annonce (éditable par les admins)
    var announce = el("div", { id: "boardAnnounce" }, [el("span", { class: "loading", text: "Chargement…" })]);
    host.appendChild(announce);

    // 2) nouveautés (dernières modifications)
    host.appendChild(el("div", { class: "stencil", style: "margin-top:24px", text: "Nouveautés" }));
    var news = el("div", { id: "boardNews" }, [el("span", { class: "loading", text: "Chargement…" })]);
    host.appendChild(news);

    renderBoardAnnounce(announce);
    renderBoardNews(news);
  }

  // ---- panneau d'annonce -------------------------------------------------
  function renderBoardAnnounce(host) {
    if (isAdmin()) {
      clear(host); host.appendChild(el("span", { class: "loading", text: "Chargement…" }));
      loadForEdit("board.json")
        .then(function (r) { data.board = normalizeBoard(r.obj); renderBoardEditor(host); })
        .catch(function (e) { loadError(host, "Impossible de charger le panneau pour édition (" + e.message + ").", function () { renderBoardAnnounce(host); }); });
      return;
    }
    fetch("data/board.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (o) { data.board = normalizeBoard(o); renderBoardReadonly(host); });
  }

  function renderBoardReadonly(host) {
    clear(host);
    var b = data.board || normalizeBoard(null);
    if (!b.title && !b.body) {
      host.appendChild(el("p", { class: "list-empty", text: "Aucune annonce pour le moment." }));
      return;
    }
    var card = el("div", { class: "briefing board-announce" });
    if (b.title) card.appendChild(el("div", { class: "board-announce__title", text: b.title }));
    if (b.body) card.appendChild(el("div", { class: "board-announce__body", text: b.body }));
    if (b.updated) card.appendChild(el("div", { class: "board-announce__meta", text: "Mis à jour le " + b.updated }));
    host.appendChild(card);
  }

  function renderBoardEditor(host) {
    clear(host);
    var b = data.board || normalizeBoard(null);

    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition du panneau d'affichage — n'oublie pas d'enregistrer." })
    ]));

    var card = el("div", { class: "card" });
    var title = el("input", { class: "input", type: "text", value: b.title, placeholder: "Titre de l'annonce…" });
    var body = el("textarea", { class: "textarea", rows: "6", placeholder: "Texte affiché en haut de l'accueil…" });
    body.value = b.body;
    card.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Titre" }), title]));
    card.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Message" }), body]));

    var status = el("span", { class: "editor__status" });
    var save = el("button", { class: "btn btn--amber", text: "Enregistrer le panneau" });
    save.addEventListener("click", function () {
      var today = new Date();
      var obj = {
        title: title.value.trim(),
        body: body.value.trim(),
        updated: today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate())
      };
      saveData("board.json", obj, status, save, function () { data.board = normalizeBoard(obj); });
    });
    card.appendChild(el("div", { class: "editor__foot" }, [save, status]));
    host.appendChild(card);
  }

  /* ---- nouveautés : dernières modifications, changelog + planner ----------
     On retient « le dernier jour de modifications » toutes sources confondues :
     la date la plus récente parmi les dates du changelog et les dates de dernière
     modification des tickets du planner. On affiche ensuite tout ce qui date de
     ce jour-là. */
  function dayOf(s) { return typeof s === "string" ? s.slice(0, 10) : ""; }

  // Récolte les tickets du planner avec leur jour de dernière activité.
  // Un ticket jamais réédité (modified === created) compte comme une création.
  function collectPlannerNews(planner) {
    var cats = (planner && Array.isArray(planner.categories)) ? planner.categories : [];
    var out = [];
    cats.forEach(function (c) {
      (c.tickets || []).forEach(function (t) {
        if (!t || !(t.title || "").trim()) return;
        var modified = t.modified || t.created || "";
        var day = dayOf(modified);
        if (!day) return;
        var created = t.created || "";
        out.push({
          day: day, stamp: modified, title: t.title, category: (c.name || "").trim(),
          isNew: !created || modified === created
        });
      });
    });
    return out;
  }

  function mostRecentDay(days) {
    return days.reduce(function (m, d) { return d > m ? d : m; }, days[0]);
  }

  // Crée une section « Nouveautés » : un titre (jour) + un conteneur .log.
  function newsSection(host, heading) {
    var box = el("div", { class: "log" });
    host.appendChild(el("div", { class: "board-news__section" }, [
      el("p", { class: "board-news__day", text: heading }),
      box
    ]));
    return box;
  }

  function renderBoardNews(host) {
    Promise.all([
      fetch("data/changelog.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      fetch("data/planner.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    ]).then(function (res) {
      clear(host);
      var entries = Array.isArray(res[0]) ? res[0].filter(function (e) { return e && typeof e === "object"; }) : [];
      var plNews = collectPlannerNews(res[1] && typeof res[1] === "object" ? res[1] : {});
      var any = false;

      // --- Changelog : son propre dernier jour de modifications ---
      var clDays = entries
        .filter(function (e) { return typeof e.date === "string" && e.date.trim() !== ""; })
        .map(function (e) { return dayOf(e.date); });
      if (clDays.length) {
        var clDay = mostRecentDay(clDays);
        renderChangelogDay(newsSection(host, "Changelog — modifications du " + clDay),
          entries.filter(function (e) { return dayOf(e.date) === clDay; }), clDay);
        any = true;
      } else if (entries.length) {
        // aucun jour exploitable : repli sur la version la plus récente
        var top = entries.slice().sort(function (a, b) { return GammaCore.cmpVersion(b.version, a.version); })[0];
        renderChangelogDay(newsSection(host, "Changelog — dernière version"), [top], null);
        any = true;
      }

      // --- Planner : son propre dernier jour de modifications ---
      if (plNews.length) {
        var plDay = mostRecentDay(plNews.map(function (n) { return n.day; }));
        renderPlannerDay(newsSection(host, "Planner — modifications du " + plDay),
          plNews.filter(function (n) { return n.day === plDay; }));
        any = true;
      }

      if (!any) {
        host.appendChild(el("p", { class: "list-empty", text: "Aucune modification récente." }));
        return;
      }
      host.appendChild(el("button", {
        class: "btn btn--ghost btn--mini", style: "margin-top:18px", text: "Voir tout le changelog →",
        onClick: function () { navigateTab("changelog"); }
      }));
    });
  }

  function renderChangelogDay(box, dayEntries, day) {
    dayEntries
      .slice()
      .sort(function (a, b) { return GammaCore.cmpVersion(b.version, a.version); })
      .forEach(function (e) {
        var head = el("div", { class: "log-entry__head" }, [
          el("span", { class: "log-entry__ver", text: "v" + (e.version || "?") }),
          (e.date && dayOf(e.date) !== day) ? el("span", { class: "log-entry__date", text: e.date }) : null
        ]);
        var ul = el("ul", { class: "log-entry__changes" });
        (e.changes || []).forEach(function (c) { ul.appendChild(el("li", { text: c })); });
        box.appendChild(el("div", { class: "log-entry" }, [head, ul]));
      });
  }

  function renderPlannerDay(box, items) {
    var ul = el("ul", { class: "log-entry__changes" });
    items
      .slice()
      .sort(function (a, b) { return a.stamp < b.stamp ? 1 : -1; })
      .forEach(function (n) {
        var label = (n.isNew ? "Nouvelle tâche : " : "Tâche mise à jour : ") + n.title + (n.category ? " — " + n.category : "");
        ul.appendChild(el("li", { text: label }));
      });
    box.appendChild(el("div", { class: "log-entry" }, [ul]));
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
        loaded.files = false;
        loadError(host,
          "Configurateur indisponible : data/patches.json introuvable ou invalide (" + e.message + ").",
          loadFiles);
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
    { id: "base",  label: "G.A.M.M.A. base",  desc: "Patch français couvrant uniquement G.A.M.M.A. de base (0 mod supplémentaire comme sortie d'installation)." },
    { id: "tweak", label: "G.A.M.M.A. tweak", desc: "Patch français couvrant uniquement G.A.M.M.A. de base & l'ensemble des mods désactivés à l'installation de G.A.M.M.A." },
    { id: "extra", label: "G.A.M.M.A. extra", desc: "Patch français couvrant uniquement G.A.M.M.A. de base & l'ensemble des mods désactivés à l'installation de G.A.M.M.A. & bien d'autres mod externe à G.A.M.M.A. ! Si vous souhaitez ajouter une traduction pour un mod non couvert par le Pack, Rendez-vous dans l'onglet CONTACT afin de nous le suggérer." }
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
  function baseName(path) { return GammaCore.baseName(path); }
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

    var sources = [{ label: "GAMMA base", priority: -Infinity, files: manifest.base.files }];
    chosen.forEach(function (p) { sources.push({ label: p.name || p.id, priority: Number(p.priority) || 0, files: p.files }); });

    var r = GammaCore.resolveFiles(sources);
    return { level: level, patches: chosen, files: r.files, warnings: r.warnings, mainfile: manifest.mainfile.files };
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
    var prefix = (config.patch_base || "0. PatchVF") + "/MainFile/";
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
        status.textContent = failed.length + " fichier(s) introuvable(s). Vérifie que 0. PatchVF est publié sur le site. Premier échec : " + failed[0];
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
        loadError(host, "Impossible de charger la liste (" + e.message + ").", loadListe);
      });
  }

  function renderListe() {
    if (!isAdmin()) { renderListeReadonly(); return; }
    // mode admin : on recharge la version autoritative (+ SHA) avant d'éditer
    var host = $("#listeHost");
    clear(host); host.appendChild(el("span", { class: "loading", text: "Chargement…" }));
    loadForEdit("liste.json")
      .then(function (r) { data.liste = Array.isArray(r.obj) ? r.obj : []; renderListeEditor(); })
      .catch(function (e) { loadError(host, "Impossible de charger la liste pour édition (" + e.message + ").", renderListe); });
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
        loadError(host, "Impossible de charger le changelog (" + e.message + ").", loadChangelog);
      });
  }

  function renderChangelog() {
    if (!isAdmin()) { renderChangelogReadonly(); return; }
    var host = $("#logHost");
    clear(host); host.appendChild(el("span", { class: "loading", text: "Chargement…" }));
    loadForEdit("changelog.json")
      .then(function (r) { data.changelog = Array.isArray(r.obj) ? r.obj : []; renderChangelogEditor(); })
      .catch(function (e) { loadError(host, "Impossible de charger le changelog pour édition (" + e.message + ").", renderChangelog); });
  }

  function renderChangelogReadonly() {
    var host = $("#logHost");
    clear(host);
    var entries = (data.changelog || []).slice().sort(function (a, b) { return GammaCore.cmpVersion(b.version, a.version); });
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

  /* =======================================================================
     ONGLET PLANNER — tableau de bord façon « 365 Planner »
     Lecture publique (catégories, tickets, étiquettes, échéances, actions,
     commentaires). Édition réservée à l'admin déverrouillé, persistée en un
     seul fichier data/planner.json via le Worker (comme Liste / Changelog).
     ======================================================================= */
  var plannerDraft = null;                       // copie de travail (mode admin)
  var dragState = null;                          // glisser-déposer : { fromCat, tk }
  var PLABELS = ["green", "amber", "rust", "ok", "cyan", "violet"];
  var PSTATUS = { todo: "À faire", doing: "En cours", done: "Terminé" };

  function plUid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function plClone(o) { return JSON.parse(JSON.stringify(o)); }

  // Empreinte du *contenu* d'un ticket (hors id/created/modified) : sert à
  // détecter une vraie modification à la fermeture de l'éditeur pour dater le
  // champ « modified ».
  function ticketFingerprint(t) {
    return JSON.stringify({
      title: t.title, description: t.description, status: t.status,
      due: t.due, labels: t.labels, actions: t.actions, comments: t.comments
    });
  }

  function normalizeTicket(t) {
    t = t && typeof t === "object" ? t : {};
    return {
      id: t.id || plUid("tk"),
      title: String(t.title || ""),
      description: String(t.description || ""),
      status: PSTATUS[t.status] ? t.status : "todo",
      due: String(t.due || ""),
      labels: Array.isArray(t.labels) ? t.labels.slice() : [],
      actions: (Array.isArray(t.actions) ? t.actions : []).map(function (a) {
        a = a || {};
        return { id: a.id || plUid("ac"), text: String(a.text || ""), done: !!a.done };
      }),
      comments: (Array.isArray(t.comments) ? t.comments : []).map(function (c) {
        c = c || {};
        return { id: c.id || plUid("cm"), author: String(c.author || "Admin"), date: String(c.date || ""), text: String(c.text || "") };
      }),
      created: String(t.created || ""),
      modified: String(t.modified || t.created || "")
    };
  }

  function normalizePlanner(o) {
    o = o && typeof o === "object" ? o : {};
    return {
      labels: (Array.isArray(o.labels) ? o.labels : []).map(function (l) {
        l = l || {};
        return { id: l.id || plUid("lbl"), name: String(l.name || ""), color: PLABELS.indexOf(l.color) !== -1 ? l.color : "green" };
      }),
      categories: (Array.isArray(o.categories) ? o.categories : []).map(function (c) {
        c = c || {};
        return { id: c.id || plUid("cat"), name: String(c.name || ""), tickets: (Array.isArray(c.tickets) ? c.tickets : []).map(normalizeTicket) };
      })
    };
  }

  function findLabel(p, id) {
    for (var i = 0; i < p.labels.length; i++) if (p.labels[i].id === id) return p.labels[i];
    return null;
  }
  function isOverdue(due) {
    if (!due) return false;
    var d = new Date(due + "T23:59:59");
    return !isNaN(d.getTime()) && d.getTime() < Date.now();
  }

  function loadPlanner() {
    var host = $("#plannerHost");
    if (data.planner !== null) { renderPlanner(); return; }
    fetchJSON("data/planner.json")
      .then(function (o) { data.planner = normalizePlanner(o); renderPlanner(); })
      .catch(function (e) {
        loadError(host, "Impossible de charger le planner (" + e.message + ").", loadPlanner);
      });
  }

  function renderPlanner() {
    if (!isAdmin()) { renderPlannerReadonly(); return; }
    // mode admin : version autoritative (+ SHA) et liste des pseudos pour les commentaires
    var host = $("#plannerHost");
    clear(host); host.appendChild(el("span", { class: "loading", text: "Chargement…" }));
    Promise.all([loadForEdit("planner.json"), loadAdmins()])
      .then(function (res) {
        data.planner = normalizePlanner(res[0].obj || {});
        plannerDraft = plClone(data.planner);
        renderPlannerAdmin();
      })
      .catch(function (e) { loadError(host, "Impossible de charger le planner pour édition (" + e.message + ").", renderPlanner); });
  }

  function renderPlannerReadonly() {
    var host = $("#plannerHost");
    clear(host);
    if (!data.planner.categories.length) {
      host.appendChild(el("p", { class: "list-empty", text: "Le planificateur est vide pour le moment." }));
      return;
    }
    host.appendChild(buildBoard(data.planner, false));
  }

  function renderPlannerAdmin() {
    var host = $("#plannerHost");
    clear(host);
    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition du planner — pense à enregistrer." }),
      el("button", { class: "btn btn--ghost btn--mini", text: "Gérer les étiquettes", onClick: openLabelManager })
    ]));
    host.appendChild(el("div", { id: "plannerBoardWrap" }));
    var status = el("span", { class: "editor__status" });
    var save = el("button", { class: "btn btn--amber", text: "Enregistrer le planner" });
    save.addEventListener("click", function () { savePlanner(status, save); });
    host.appendChild(el("div", { class: "editor__foot" }, [save, status]));
    paintBoard();
  }

  function paintBoard() {
    var wrap = $("#plannerBoardWrap");
    if (!wrap) return;
    clear(wrap);
    wrap.appendChild(buildBoard(plannerDraft, true));
  }

  function buildBoard(p, editable) {
    var board = el("div", { class: "board" });
    p.categories.forEach(function (cat) { board.appendChild(buildBucket(p, cat, editable)); });
    if (editable) {
      board.appendChild(el("div", { class: "bucket bucket--add" }, [
        el("button", { class: "btn btn--ghost btn--wide", text: "+ Catégorie", onClick: function () {
          plannerDraft.categories.push({ id: plUid("cat"), name: "Nouvelle catégorie", tickets: [] });
          paintBoard();
        } })
      ]));
    }
    return board;
  }

  function buildBucket(p, cat, editable) {
    var head;
    if (editable) {
      var nameInp = el("input", { class: "bucket__edit", type: "text", value: cat.name, placeholder: "Catégorie…" });
      nameInp.addEventListener("input", function () { cat.name = nameInp.value; });
      var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer la catégorie", text: "✕", onClick: function () {
        if (cat.tickets.length && !window.confirm("Supprimer « " + (cat.name || "cette catégorie") + " » et ses " + cat.tickets.length + " ticket(s) ?")) return;
        var i = plannerDraft.categories.indexOf(cat);
        if (i !== -1) plannerDraft.categories.splice(i, 1);
        paintBoard();
      } });
      head = el("div", { class: "bucket__head" }, [nameInp, el("span", { class: "bucket__count", text: String(cat.tickets.length) }), del]);
    } else {
      head = el("div", { class: "bucket__head" }, [
        el("span", { class: "bucket__name", text: cat.name || "Sans nom" }),
        el("span", { class: "bucket__count", text: String(cat.tickets.length) })
      ]);
    }

    var cards = el("div", { class: "bucket__cards" });
    cat.tickets.forEach(function (tk) { cards.appendChild(buildCard(p, cat, tk, editable)); });

    var bucket = el("div", { class: "bucket" }, [head, cards]);
    if (editable) {
      // zone de dépôt : déplacer un ticket dans cette catégorie (et le réordonner)
      cards.addEventListener("dragover", function (e) {
        if (!dragState) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        bucket.classList.add("is-dropzone");
      });
      cards.addEventListener("dragleave", function (e) {
        if (e.target === cards) bucket.classList.remove("is-dropzone");
      });
      cards.addEventListener("drop", function (e) {
        if (!dragState) return;
        e.preventDefault();
        bucket.classList.remove("is-dropzone");
        moveTicket(dragState.fromCat, cat, cards, e.clientY, dragState.tk);
      });
      bucket.appendChild(el("button", { class: "btn btn--ghost btn--mini bucket__add", text: "+ ticket", onClick: function () {
        var tk = normalizeTicket({ created: new Date().toISOString() });
        cat.tickets.push(tk);
        openTicketEdit(cat, tk);
      } }));
    }
    return bucket;
  }

  // Élément après lequel insérer, selon la position verticale du curseur.
  function dragAfter(container, y) {
    var els = Array.prototype.slice.call(container.querySelectorAll(".tcard:not(.is-dragging)"));
    var closest = null, closestOffset = -Infinity;
    els.forEach(function (child) {
      var box = child.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = child; }
    });
    return closest; // null => insérer en fin
  }

  function moveTicket(fromCat, toCat, container, y, tk) {
    var si = fromCat.tickets.indexOf(tk);
    if (si !== -1) fromCat.tickets.splice(si, 1);
    var after = dragAfter(container, y);
    var idx = toCat.tickets.length;
    if (after) {
      var aid = after.getAttribute("data-tkid");
      for (var i = 0; i < toCat.tickets.length; i++) { if (toCat.tickets[i].id === aid) { idx = i; break; } }
    }
    toCat.tickets.splice(idx, 0, tk);
    dragState = null;
    paintBoard();
  }

  function buildCard(p, cat, tk, editable) {
    var children = [];
    if (tk.labels.length) {
      var lab = el("div", { class: "tcard__labels" });
      tk.labels.forEach(function (lid) { var l = findLabel(p, lid); if (l) lab.appendChild(el("span", { class: "plabel plabel--" + l.color, text: l.name })); });
      children.push(lab);
    }
    children.push(el("div", { class: "tcard__title", text: tk.title || "(sans titre)" }));

    var foot = el("div", { class: "tcard__foot" }, [el("span", { class: "tcard__status tcard__status--" + tk.status, text: PSTATUS[tk.status] })]);
    if (tk.due) {
      var late = tk.status !== "done" && isOverdue(tk.due);
      foot.appendChild(el("span", { class: "pbadge" + (late ? " pbadge--late" : ""), text: tk.due }));
    }
    if (tk.actions.length) {
      var done = tk.actions.filter(function (a) { return a.done; }).length;
      foot.appendChild(el("span", { class: "pbadge", text: "✓ " + done + "/" + tk.actions.length }));
    }
    if (tk.comments.length) foot.appendChild(el("span", { class: "pbadge", text: tk.comments.length + " comm." }));
    children.push(foot);

    var card = el("div", {
      class: "tcard tcard--" + tk.status, tabindex: "0", role: "button",
      "data-tkid": tk.id, draggable: editable ? "true" : null
    }, children);
    function open() { if (editable) openTicketEdit(cat, tk); else openTicketView(tk); }
    card.addEventListener("click", open);
    card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    if (editable) {
      card.addEventListener("dragstart", function (e) {
        dragState = { fromCat: cat, tk: tk };
        card.classList.add("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", tk.id); } catch (_) {}
        }
      });
      card.addEventListener("dragend", function () {
        dragState = null;
        card.classList.remove("is-dragging");
        $all(".bucket.is-dropzone").forEach(function (b) { b.classList.remove("is-dropzone"); });
      });
    }
    return card;
  }

  /* ---- fenêtre modale partagée ---- */
  var modalOnClose = null;
  var modalReturnFocus = null;
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function openModal(content, onClose) {
    closeModal();
    modalOnClose = onClose || null;
    modalReturnFocus = document.activeElement; // pour restaurer le focus à la fermeture
    var panel = el("div", { class: "modal__panel", role: "dialog", "aria-modal": "true", tabindex: "-1" }, [content]);
    var backdrop = el("div", { class: "modal", id: "plannerModal" }, [panel]);
    backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) closeModal(); });
    document.addEventListener("keydown", modalKeydown, true);
    document.body.appendChild(backdrop);
    document.body.classList.add("modal-open");
    // focus initial dans la modale (premier élément focusable, sinon le panneau)
    var first = panel.querySelector(FOCUSABLE);
    (first || panel).focus();
  }

  // Escape ferme ; Tab/Maj+Tab reste piégé dans la modale (pas d'évasion vers l'arrière-plan)
  function modalKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key !== "Tab") return;
    var panel = $("#plannerModal .modal__panel");
    if (!panel) return;
    var items = Array.prototype.slice.call(panel.querySelectorAll(FOCUSABLE));
    if (!items.length) { e.preventDefault(); panel.focus(); return; }
    var firstEl = items[0], lastEl = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey) {
      if (active === firstEl || active === panel || !panel.contains(active)) { e.preventDefault(); lastEl.focus(); }
    } else {
      if (active === lastEl || !panel.contains(active)) { e.preventDefault(); firstEl.focus(); }
    }
  }

  function closeModal() {
    var m = $("#plannerModal");
    if (!m) return;
    if (m.parentNode) m.parentNode.removeChild(m);
    document.removeEventListener("keydown", modalKeydown, true);
    document.body.classList.remove("modal-open");
    var cb = modalOnClose; modalOnClose = null;
    var rf = modalReturnFocus; modalReturnFocus = null;
    if (cb) cb();
    if (rf && typeof rf.focus === "function") rf.focus(); // restaure le focus au déclencheur
  }

  // Bandeau de dates affiché en tête d'un ticket : création + dernière
  // modification (masquée si identique à la création).
  function ticketStamps(tk) {
    if (!tk.created && !tk.modified) return null;
    var row = el("div", { class: "tstamp" });
    if (tk.created) row.appendChild(el("span", { text: "Créé le " + fmtDate(tk.created) }));
    if (tk.modified && tk.modified !== tk.created) row.appendChild(el("span", { text: "Dernière modification le " + fmtDate(tk.modified) }));
    return row;
  }

  function openTicketView(tk) {
    var p = data.planner;
    var content = el("div", { class: "modal__inner" });
    content.appendChild(el("div", { class: "modal__head" }, [
      el("h3", { class: "modal__title", text: tk.title || "(sans titre)" }),
      el("button", { class: "btn btn--ghost btn--icon", title: "Fermer", text: "✕", onClick: closeModal })
    ]));
    var body = el("div", { class: "modal__body" });
    content.appendChild(body);

    var stamps = ticketStamps(tk);
    if (stamps) body.appendChild(stamps);

    var meta = el("div", { class: "tmeta" }, [el("span", { class: "tcard__status tcard__status--" + tk.status, text: PSTATUS[tk.status] })]);
    if (tk.due) meta.appendChild(el("span", { class: "pbadge" + (tk.status !== "done" && isOverdue(tk.due) ? " pbadge--late" : ""), text: "Échéance : " + tk.due }));
    body.appendChild(meta);

    if (tk.labels.length) {
      var lab = el("div", { class: "tcard__labels" });
      tk.labels.forEach(function (lid) { var l = findLabel(p, lid); if (l) lab.appendChild(el("span", { class: "plabel plabel--" + l.color, text: l.name })); });
      body.appendChild(lab);
    }
    if (tk.description) body.appendChild(el("p", { class: "tdesc", text: tk.description }));

    if (tk.actions.length) {
      body.appendChild(el("div", { class: "tsub", text: "Actions" }));
      var ul = el("div", { class: "pchecks" });
      tk.actions.forEach(function (a) {
        ul.appendChild(el("div", { class: "pcheck" + (a.done ? " is-done" : "") }, [
          el("span", { class: "pcheck__box", text: a.done ? "✓" : "" }),
          el("span", { class: "pcheck__text", text: a.text })
        ]));
      });
      body.appendChild(ul);
    }

    body.appendChild(el("div", { class: "tsub", text: "Commentaires (" + tk.comments.length + ")" }));
    if (tk.comments.length) {
      var cbox = el("div", { class: "pcomments" });
      tk.comments.forEach(function (c) {
        cbox.appendChild(el("div", { class: "pcomment" }, [
          el("div", { class: "pcomment__meta", text: (c.author || "Admin") + " · " + fmtDate(c.date) }),
          el("div", { class: "pcomment__text", text: c.text })
        ]));
      });
      body.appendChild(cbox);
    } else {
      body.appendChild(el("p", { class: "list-empty", text: "Aucun commentaire." }));
    }
    openModal(content, null);
  }

  // Sélecteur d'auteur d'un commentaire : liste déroulante des pseudos admin
  // (gérés dans l'onglet Admin) ; repli sur un champ texte si la liste est vide.
  function buildAuthorPicker() {
    var admins = data.admins || [];
    if (admins.length) {
      if (admins.indexOf(lastAuthor) === -1) lastAuthor = admins[0];
      var sel = el("select", { class: "input select input--sm", "aria-label": "Auteur" });
      admins.forEach(function (name) {
        var o = el("option", { value: name, text: name });
        if (name === lastAuthor) o.selected = true;
        sel.appendChild(o);
      });
      sel.value = lastAuthor;
      return { node: sel, value: function () { lastAuthor = sel.value; return sel.value; } };
    }
    var inp = el("input", { class: "input input--sm", type: "text", value: lastAuthor || "Admin", placeholder: "Auteur" });
    return { node: inp, value: function () { var v = inp.value.trim() || "Admin"; lastAuthor = v; return v; } };
  }

  function openTicketEdit(cat, tk) {
    var p = plannerDraft;
    var snapshot = ticketFingerprint(tk); // pour dater « modified » si le contenu change
    var content = el("div", { class: "modal__inner" });

    var titleInp = el("input", { class: "input modal__titleinput", type: "text", value: tk.title, placeholder: "Titre du ticket" });
    titleInp.addEventListener("input", function () { tk.title = titleInp.value; });
    content.appendChild(el("div", { class: "modal__head" }, [
      titleInp,
      el("button", { class: "btn btn--ghost btn--icon", title: "Fermer", text: "✕", onClick: closeModal })
    ]));

    var body = el("div", { class: "modal__body" });
    content.appendChild(body);

    var stamps = ticketStamps(tk);
    if (stamps) body.appendChild(stamps);

    var status = el("select", { class: "input select input--sm" });
    Object.keys(PSTATUS).forEach(function (k) {
      var o = el("option", { value: k, text: PSTATUS[k] });
      if (tk.status === k) o.selected = true;
      status.appendChild(o);
    });
    status.addEventListener("change", function () { tk.status = status.value; });
    var due = el("input", { class: "input input--sm", type: "date", value: tk.due || "" });
    due.addEventListener("input", function () { tk.due = due.value; });
    body.appendChild(el("div", { class: "frow" }, [
      el("label", { class: "field field--inline" }, [el("span", { class: "field__label", text: "État" }), status]),
      el("label", { class: "field field--inline" }, [el("span", { class: "field__label", text: "Date de réalisation" }), due])
    ]));

    var desc = el("textarea", { class: "textarea", rows: "3", placeholder: "Description…" });
    desc.value = tk.description;
    desc.addEventListener("input", function () { tk.description = desc.value; });
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Description" }), desc]));

    body.appendChild(el("span", { class: "field__label", text: "Étiquettes" }));
    var labWrap = el("div", { class: "labelpick" });
    body.appendChild(labWrap);

    body.appendChild(el("div", { class: "tsub", text: "Actions" }));
    var actBox = el("div", { class: "pchecks" });
    body.appendChild(actBox);

    body.appendChild(el("div", { class: "tsub", text: "Commentaires" }));
    var comBox = el("div", { class: "pcomments" });
    body.appendChild(comBox);
    var authorPick = buildAuthorPicker();
    var cText = el("input", { class: "input", type: "text", placeholder: "Ajouter un commentaire…" });
    var cAdd = el("button", { class: "btn btn--ghost btn--mini", text: "Commenter" });
    body.appendChild(el("div", { class: "commentadd" }, [authorPick.node, cText, cAdd]));

    content.appendChild(el("div", { class: "modal__foot" }, [
      el("button", { class: "btn btn--ghost btn--danger", text: "Supprimer le ticket", onClick: function () {
        if (!window.confirm("Supprimer ce ticket ?")) return;
        var i = cat.tickets.indexOf(tk);
        if (i !== -1) cat.tickets.splice(i, 1);
        closeModal();
      } }),
      el("span", { class: "muted-note", text: "Pense à « Enregistrer le planner »." }),
      el("button", { class: "btn btn--amber", text: "Fermer", onClick: closeModal })
    ]));

    function paintLabels() {
      clear(labWrap);
      if (!p.labels.length) { labWrap.appendChild(el("span", { class: "muted-note", text: "Aucune étiquette (voir « Gérer les étiquettes »)." })); return; }
      p.labels.forEach(function (l) {
        var on = tk.labels.indexOf(l.id) !== -1;
        var chip = el("button", { class: "plabel plabel--" + l.color + (on ? " is-on" : " is-off"), text: l.name || "?" });
        chip.addEventListener("click", function () {
          var i = tk.labels.indexOf(l.id);
          if (i === -1) tk.labels.push(l.id); else tk.labels.splice(i, 1);
          paintLabels();
        });
        labWrap.appendChild(chip);
      });
    }
    function paintActions() {
      clear(actBox);
      tk.actions.forEach(function (a, i) {
        var toggle = el("button", { class: "pcheck__toggle" + (a.done ? " is-done" : ""), text: a.done ? "✓" : "", title: "Cocher" });
        toggle.addEventListener("click", function () { a.done = !a.done; paintActions(); });
        var txt = el("input", { class: "input input--bare", type: "text", value: a.text, placeholder: "Action…" });
        txt.addEventListener("input", function () { a.text = txt.value; });
        var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕", onClick: function () { tk.actions.splice(i, 1); paintActions(); } });
        actBox.appendChild(el("div", { class: "pcheck pcheck--edit" + (a.done ? " is-done" : "") }, [toggle, txt, del]));
      });
      actBox.appendChild(el("button", { class: "btn btn--ghost btn--mini", text: "+ action", onClick: function () { tk.actions.push({ id: plUid("ac"), text: "", done: false }); paintActions(); } }));
    }
    function paintComments() {
      clear(comBox);
      tk.comments.forEach(function (c, i) {
        comBox.appendChild(el("div", { class: "pcomment" }, [
          el("div", { class: "pcomment__meta" }, [
            el("span", { text: (c.author || "Admin") + " · " + fmtDate(c.date) }),
            el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕", onClick: function () { tk.comments.splice(i, 1); paintComments(); } })
          ]),
          el("div", { class: "pcomment__text", text: c.text })
        ]));
      });
      if (!tk.comments.length) comBox.appendChild(el("p", { class: "list-empty", text: "Aucun commentaire." }));
    }
    cAdd.addEventListener("click", function () {
      var t = cText.value.trim(); if (!t) return;
      tk.comments.push({ id: plUid("cm"), author: authorPick.value(), date: new Date().toISOString(), text: t });
      cText.value = ""; paintComments();
    });
    cText.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); cAdd.click(); } });

    paintLabels(); paintActions(); paintComments();
    openModal(content, function () {
      // marque la date de dernière modification si le contenu a réellement changé
      if (ticketFingerprint(tk) !== snapshot) tk.modified = new Date().toISOString();
      paintBoard();
    });
  }

  function openLabelManager() {
    var p = plannerDraft;
    var content = el("div", { class: "modal__inner" });
    content.appendChild(el("div", { class: "modal__head" }, [
      el("h3", { class: "modal__title", text: "Étiquettes" }),
      el("button", { class: "btn btn--ghost btn--icon", title: "Fermer", text: "✕", onClick: closeModal })
    ]));
    var body = el("div", { class: "modal__body" });
    content.appendChild(body);
    var listBox = el("div", { class: "labellist" });
    body.appendChild(listBox);

    function paint() {
      clear(listBox);
      p.labels.forEach(function (l, i) {
        var name = el("input", { class: "input input--sm", type: "text", value: l.name, placeholder: "Nom de l'étiquette" });
        name.addEventListener("input", function () { l.name = name.value; });
        var colors = el("div", { class: "colorpick" });
        PLABELS.forEach(function (col) {
          var sw = el("button", { class: "swatch plabel--" + col + (l.color === col ? " is-on" : ""), title: col, "aria-label": col });
          sw.addEventListener("click", function () { l.color = col; paint(); });
          colors.appendChild(sw);
        });
        var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕", onClick: function () {
          p.categories.forEach(function (c) { c.tickets.forEach(function (t) { var k = t.labels.indexOf(l.id); if (k !== -1) t.labels.splice(k, 1); }); });
          p.labels.splice(i, 1); paint();
        } });
        listBox.appendChild(el("div", { class: "labelrow" }, [name, colors, del]));
      });
      if (!p.labels.length) listBox.appendChild(el("p", { class: "list-empty", text: "Aucune étiquette." }));
    }
    paint();

    body.appendChild(el("button", { class: "btn btn--ghost btn--mini", text: "+ étiquette", onClick: function () {
      p.labels.push({ id: plUid("lbl"), name: "", color: PLABELS[p.labels.length % PLABELS.length] }); paint();
    } }));

    content.appendChild(el("div", { class: "modal__foot" }, [
      el("span", { class: "muted-note", text: "Pense à « Enregistrer le planner »." }),
      el("button", { class: "btn btn--amber", text: "Fermer", onClick: closeModal })
    ]));
    openModal(content, paintBoard);
  }

  function savePlanner(status, btn) {
    var d = plannerDraft;
    var labels = d.labels.filter(function (l) { return (l.name || "").trim() !== ""; })
      .map(function (l) { return { id: l.id, name: l.name.trim(), color: l.color }; });
    var kept = {};
    labels.forEach(function (l) { kept[l.id] = true; });
    var clean = {
      generated: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
      labels: labels,
      categories: d.categories.map(function (c) {
        return {
          id: c.id,
          name: (c.name || "").trim(),
          tickets: c.tickets.filter(function (t) { return (t.title || "").trim() !== ""; }).map(function (t) {
            return {
              id: t.id,
              title: t.title.trim(),
              description: (t.description || "").trim(),
              status: t.status,
              due: (t.due || "").trim(),
              labels: t.labels.filter(function (lid) { return kept[lid]; }),
              actions: t.actions.filter(function (a) { return (a.text || "").trim() !== ""; })
                .map(function (a) { return { id: a.id, text: a.text.trim(), done: !!a.done }; }),
              comments: t.comments.map(function (cc) { return { id: cc.id, author: cc.author || "Admin", date: cc.date, text: cc.text }; }),
              created: t.created || "",
              modified: t.modified || t.created || ""
            };
          })
        };
      })
    };
    saveData("planner.json", clean, status, btn, function () {
      data.planner = normalizePlanner(clean);
      plannerDraft = plClone(data.planner);
      paintBoard();
    });
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

      // honeypot : si ce champ caché est rempli, c'est un bot → faux succès, rien n'est envoyé
      var hp = ($("#cWebsite") && $("#cWebsite").value) || "";
      if (hp) {
        showNotice(notice, "ok", "Message envoyé. Merci !");
        $("#cName").value = ""; $("#cObjet").value = ""; $("#cMessage").value = ""; $("#cWebsite").value = "";
        return;
      }

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

  // ---- verrouillage automatique après inactivité -------------------------
  var IDLE_MS = 20 * 60 * 1000;   // 20 min sans interaction → déconnexion
  var idleTimer = null;
  var adminLockReason = "";
  var IDLE_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];

  function resetIdle() {
    if (!isAdmin()) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { lockAdmin(true); }, IDLE_MS);
  }
  function startIdleWatch() {
    IDLE_EVENTS.forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true }); });
    resetIdle();
  }
  function stopIdleWatch() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    IDLE_EVENTS.forEach(function (ev) { document.removeEventListener(ev, resetIdle); });
  }

  function lockAdmin(idle) {
    leavePresence();            // signale le départ tant que le mot de passe est en mémoire
    admin.unlocked = false; admin.pwd = ""; adminDirty = false;
    stopIdleWatch();
    presenceTick();             // rafraîchit le compteur en mode public
    adminLockReason = (idle === true) ? "Session verrouillée après 20 min d'inactivité. Reconnecte-toi." : "";
    renderAdmin();
  }

  function workerReady() {
    return !!config.worker_url && config.worker_url.indexOf("VOTRE-SOUS-DOMAINE") === -1;
  }

  function renderAdmin() {
    var host = $("#adminRoot");
    if (!host) return;
    clear(host);

    host.appendChild(el("div", { class: "admin-warn" }, [
      el("span", { class: "admin-warn__tag", text: "PRIVÉ" }),
      el("span", { text: "Accès réservé" })
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
    if (adminLockReason) { showNotice(note, "err", adminLockReason); adminLockReason = ""; }
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
          if (res.ok && res.data && res.data.success) { admin.pwd = pw; admin.unlocked = true; adminDirty = false; startIdleWatch(); presenceTick(); renderAdmin(); }
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
      el("span", { text: "Tu peux aussi modifier le Panneau d'affichage, la Liste et le Changelog dans leurs onglets." }),
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
    // capte le SHA pour le verrouillage et rafraîchit depuis la version du dépôt
    loadForEdit("config.json").then(function (r) {
      if (r.obj && typeof r.obj === "object") fields.forEach(function (f) { if (r.obj[f.key] != null) inputs[f.key].value = r.obj[f.key]; });
    }).catch(function () {});
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

    // ---- administrateurs (pseudos du sélecteur d'auteur des commentaires planner) ----
    wrap.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Administrateurs" }));
    var admCard = el("div", { class: "card" });
    admCard.appendChild(el("p", { class: "admin-note", text:
      "Pseudos proposés dans la liste déroulante « Auteur » lors de l'ajout d'un commentaire dans le Planner." }));
    var admRows = el("div", { class: "editrows" });
    admCard.appendChild(admRows);
    var admDraft = [];
    function drawAdmRows() {
      clear(admRows);
      admDraft.forEach(function (name, i) {
        var inp = el("input", { class: "input", type: "text", value: name, placeholder: "Pseudo" });
        inp.addEventListener("input", function () { admDraft[i] = inp.value; });
        var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕",
          onClick: function () { admDraft.splice(i, 1); drawAdmRows(); } });
        admRows.appendChild(el("div", { class: "editrow" }, [el("div", { class: "editrow__fields" }, [inp]), del]));
      });
      if (!admDraft.length) admRows.appendChild(el("p", { class: "list-empty", text: "Aucun admin. Ajoute un pseudo." }));
    }
    var admStatus = el("span", { class: "editor__status" });
    var admAdd = el("button", { class: "btn btn--ghost", text: "+ Ajouter un pseudo",
      onClick: function () { admDraft.push(""); drawAdmRows(); } });
    var admSave = el("button", { class: "btn btn--amber", text: "Enregistrer les admins" });
    admSave.addEventListener("click", function () {
      var clean = admDraft.map(function (s) { return (s || "").trim(); }).filter(function (s) { return s !== ""; });
      saveData("admins.json", clean, admStatus, admSave, function () { data.admins = clean; });
    });
    admCard.appendChild(el("div", { class: "editor__foot" }, [admAdd, admSave, admStatus]));
    wrap.appendChild(admCard);
    loadForEdit("admins.json")
      .then(function (r) { admDraft = Array.isArray(r.obj) ? r.obj.slice() : []; data.admins = admDraft.slice(); drawAdmRows(); })
      .catch(function () { drawAdmRows(); });

    // ---- générateur de patch.json (téléchargement local, sans Worker) ----
    wrap.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Générateur de patch.json" }));
    var pgCard = el("div", { class: "card" });
    pgCard.appendChild(el("p", { class: "admin-note", text:
      "Génère le patch.json à déposer dans 0. PatchVF/GAMMA tweak/<id>/ ou 0. PatchVF/GAMMA extra/<id>/, à côté du ou des XML (le nom du dossier <id> sert d'identifiant). data/patches.json est ensuite régénéré automatiquement par GitHub." }));

    var today = new Date();
    var todayStr = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());

    var pgName = el("input", { class: "input", type: "text", placeholder: "Dialogues crus" });
    var pgDesc = el("textarea", { class: "textarea", rows: "3", placeholder: "Registre familier et vulgaire pour les dialogues PNJ…" });
    var pgUrl  = el("input", { class: "input", type: "text", placeholder: "https://www.moddb.com/mods/…" });
    var pgPrio = el("input", { class: "input", type: "number", inputmode: "numeric", value: "50" });
    var pgDate = el("input", { class: "input", type: "date", value: todayStr });
    var pgVer  = el("input", { class: "input", type: "text", placeholder: "1.0.0" });

    pgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Nom" }), pgName]));
    pgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label" }, ["Description ", el("span", { class: "field__opt", text: "facultatif" })]), pgDesc]));
    pgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label" }, ["URL ", el("span", { class: "field__opt", text: "facultatif" })]), pgUrl]));
    pgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label" }, ["Priorité ", el("span", { class: "field__opt", text: "le plus haut gagne" })]), pgPrio]));
    pgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Date" }), pgDate]));
    pgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Version" }), pgVer]));

    var pgStatus = el("span", { class: "editor__status" });
    var pgBtn = el("button", { class: "btn btn--amber", text: "Télécharger patch.json" });
    pgBtn.addEventListener("click", function () {
      var name = pgName.value.trim();
      if (!name) { setStatus(pgStatus, "err", "Renseigne au moins le nom du patch."); return; }
      var prio = parseInt(pgPrio.value, 10); if (isNaN(prio)) prio = 0;
      var obj = {
        name: name,
        description: pgDesc.value.trim(),
        date: pgDate.value.trim(),
        version: pgVer.value.trim(),
        url: pgUrl.value.trim(),
        priority: prio
      };
      var content = JSON.stringify(obj, null, 2) + "\n";
      var url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      var a = el("a", { href: url, download: "patch.json" });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
      setStatus(pgStatus, "ok", "patch.json téléchargé.");
    });
    pgCard.appendChild(el("div", { class: "editor__foot" }, [pgBtn, pgStatus]));
    wrap.appendChild(pgCard);

    // ---- texte du lisez-moi (onglet Files) ----
    wrap.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Texte du lisez-moi (onglet Files)" }));
    var rmCard = el("div", { class: "card" });
    var rm = el("textarea", { class: "textarea", rows: "8", placeholder: "Texte affiché en haut de l'onglet Files\u2026" });
    rm.value = "Chargement\u2026"; rm.disabled = true;
    loadForEdit("files.json")
      .then(function (r) { rm.value = (r.obj && r.obj.readme) || ""; rm.disabled = false; })
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

    var payload = { password: admin.pwd, filename: filename, content: content };
    // verrouillage optimiste : on transmet la version charg\u00e9e si on la conna\u00eet
    if (Object.prototype.hasOwnProperty.call(editSha, filename)) payload.sha = editSha[filename];

    fetch(config.worker_url.replace(/\/$/, "") + "/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        return r.json().catch(function () { return { error: "Réponse illisible (HTTP " + r.status + ")" }; })
          .then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
      })
      .then(function (res) {
        if (res.ok && res.data && res.data.success) {
          // on mémorise la nouvelle version pour continuer à éditer sans recharger
          if (res.data && typeof res.data.sha !== "undefined") editSha[filename] = res.data.sha;
          clearDirty();
          setStatus(status, "ok", "Enregistré. Le site se met à jour sous peu (cache GitHub Pages).");
          if (typeof onSuccess === "function") onSuccess();
        } else if (res.status === 409) {
          setStatus(status, "err", (res.data && res.data.error) ||
            "Conflit : un autre admin a modifié ce fichier. Recharge l'éditeur avant d'enregistrer.");
        } else if (res.status === 401) {
          setStatus(status, "err", "Session expirée. Reconnecte-toi dans l'onglet Admin.");
          leavePresence(); admin.unlocked = false; admin.pwd = ""; adminDirty = false; stopIdleWatch(); presenceTick();
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
        else if (res.status === 401) { lockAdmin(); }
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

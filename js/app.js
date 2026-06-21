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
    mod_zip_name: "GAMMAFR-PatchVF",
    mod_author: "BODY",
    site_url: "https://bodyvie.github.io/GAMMAFR/",
    // Interrupteur de maintenance : false = configurateur désactivé (plus aucun
    // téléchargement). Piloté manuellement par un admin (onglet Admin).
    configurator_enabled: true
  };
  var loaded = { files: false, liste: false, changelog: false, admin: false };
  var DEFAULT_TAB = "board";   // onglet d'accueil à l'ouverture

  // numéro de version courant de l'application (dernière entrée du changelog,
  // identique au badge de la barre du haut). Sert aussi à dater le meta.ini de
  // l'archive générée. Tenu à jour par setVersionBadge().
  var appVersion = "";

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

  /* =======================================================================
     COMPTEUR DE TÉLÉCHARGEMENTS (archives d'installation générées)
     -----------------------------------------------------------------------
     Stats jour / mois / total, visibles uniquement dans l'onglet Admin.
     INDÉPENDANT du Cloudflare Worker : aucune requête ne part vers lui, son
     quota n'est donc jamais entamé. On s'appuie sur Abacus, un compteur
     public, gratuit et sans inscription (https://abacus.jasoncameron.dev) :
     « /hit/<ns>/<clé> » incrémente et renvoie { value }, « /get/<ns>/<clé> »
     lit sans incrémenter. Son domaine est neutre (ce n'est pas un service
     d'analytics répertorié), donc les bloqueurs de pub — qui ciblent les
     domaines de tracking connus — ne le filtrent pas. Comptage anonyme :
     aucun cookie, aucune donnée personnelle.

     Trois compteurs sont incrémentés à chaque archive remise :
       total          cumul de tous les téléchargements
       m-AAAA-MM      total du mois en cours
       d-AAAA-MM-JJ   total du jour
     Les clés de date sont TOUJOURS calculées au fuseau Europe/Paris, pour que
     la frontière jour/mois soit la même quel que soit le fuseau du visiteur.

     Limite assumée : un compteur public côté client est, par nature, gonflable
     par quiconque lit ce code (pas de secret possible sans backend). Le
     namespace peu devinable ci-dessous limite seulement le risque.
     Pour repartir de zéro ou changer de service : modifier DLCOUNT_BASE /
     DLCOUNT_NS (un nouveau namespace = compteurs neufs). Rien d'autre n'en dépend.
     ======================================================================= */
  var DLCOUNT_BASE = "https://abacus.jasoncameron.dev";
  var DLCOUNT_NS = "gammafr-dl-bodyvie-7k2p9x";

  // Clés de date au fuseau Europe/Paris → { day:"AAAA-MM-JJ", month:"AAAA-MM" }.
  function dlcountDateKeys(d) {
    var o = {};
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d || new Date()).forEach(function (p) {
      if (p.type !== "literal") o[p.type] = p.value;
    });
    return { day: o.year + "-" + o.month + "-" + o.day, month: o.year + "-" + o.month };
  }

  // Incrémente un compteur (créé au premier appel). Best-effort : jamais d'attente
  // ni d'erreur propagée — le comptage ne doit jamais gêner le téléchargement.
  function dlcountHit(key) {
    try {
      // keepalive : la requête aboutit même si l'onglet se ferme juste après.
      fetch(DLCOUNT_BASE + "/hit/" + DLCOUNT_NS + "/" + encodeURIComponent(key),
        { cache: "no-store", keepalive: true }).catch(function () {});
    } catch (_) {}
  }

  // Appelé à l'instant où l'archive est effectivement remise au visiteur.
  function countArchiveDownload() {
    var k = dlcountDateKeys();
    dlcountHit("total");
    dlcountHit("m-" + k.month);
    dlcountHit("d-" + k.day);
  }

  // Lecture seule d'un compteur → Promise<number>. 404 = compteur pas encore créé
  // (0). Un échec réseau (requête filtrée, hors ligne) REJETTE : l'admin peut ainsi
  // distinguer « 0 téléchargement » de « compteur injoignable ».
  function dlcountGet(key) {
    return fetch(DLCOUNT_BASE + "/get/" + DLCOUNT_NS + "/" + encodeURIComponent(key), { cache: "no-store" })
      .then(function (r) {
        if (r.status === 404) return 0;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json().then(function (d) { return d && typeof d.value === "number" ? d.value : 0; });
      });
  }

  // Fenêtre des 7 derniers jours (clés AAAA-MM-JJ au fuseau de Paris ; dernier = aujourd'hui).
  function dlcountWindow() {
    var days = [];
    for (var i = 6; i >= 0; i--) days.push(dlcountDateKeys(new Date(Date.now() - i * 86400000)).day);
    return days;
  }

  // Stats EN DIRECT depuis Abacus : total, mois en cours, 7 derniers jours, en une
  // seule volée. Rejette si le compteur est injoignable (→ repli sur l'instantané).
  function loadLiveStats() {
    var today = dlcountDateKeys();
    var days = dlcountWindow();
    return Promise.all(
      [dlcountGet("total"), dlcountGet("m-" + today.month)]
        .concat(days.map(function (dk) { return dlcountGet("d-" + dk); }))
    ).then(function (v) {
      var dayVals = v.slice(2);
      return {
        total: v[0], month: v[1], today: dayVals[dayVals.length - 1],
        history: days.map(function (dk, i) { return { key: dk, label: dk.slice(8), n: dayVals[i] }; })
      };
    });
  }

  // REPLI : si Abacus est injoignable, on reconstruit l'affichage depuis le dernier
  // instantané conservé dans le dépôt (data/dl-stats.json, alimenté chaque jour par
  // la GitHub Action). Marqué « stale » pour le signaler clairement en admin.
  function loadSnapshotStats() {
    return fetchJSON("data/dl-stats.json", { cache: "no-store" }).then(function (s) {
      s = (s && typeof s === "object") ? s : {};
      var months = s.months || {}, days = s.days || {};
      var today = dlcountDateKeys();
      return {
        total: s.total || 0,
        month: months[today.month] || 0,
        today: days[today.day] || 0,
        history: dlcountWindow().map(function (dk) { return { key: dk, label: dk.slice(8), n: days[dk] || 0 }; }),
        stale: true,
        updated: s.updated || null
      };
    });
  }

  // Stats pour l'admin : en direct si possible, sinon repli sur l'instantané du dépôt.
  function loadDownloadStats() {
    return loadLiveStats().catch(function () { return loadSnapshotStats(); });
  }

  // Date d'un instantané (ISO) → libellé court à la française.
  function formatSnapDate(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return String(iso || "");
    try { return new Date(t).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }); }
    catch (_) { return new Date(t).toISOString(); }
  }

  // Entier formaté à la française (séparateur de milliers).
  function formatInt(n) {
    try { return Number(n || 0).toLocaleString("fr-FR"); }
    catch (_) { return String(n || 0); }
  }

  // ---- amorçage ----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    syncShareMeta();
    setupTabs();
    setupContact();
    loadConfig();
    loadVersionBadge();
    // onglet initial : déduit du #hash de l'URL (partage / rechargement), sinon l'accueil
    var initial = tabFromHash() || DEFAULT_TAB;
    if (!tabFromHash() && history.replaceState) history.replaceState(null, "", "#" + initial);
    activateTab(initial);
    // bouton Précédent/Suivant du navigateur ⇄ onglet courant
    window.addEventListener("hashchange", function () { activateTab(tabFromHash() || DEFAULT_TAB); });

    // présence : signale le départ d'un admin, rafraîchit au retour d'onglet,
    // marque l'édition en cours dès qu'un champ admin est modifié.
    window.addEventListener("beforeunload", function (e) {
      if (isAdmin()) leavePresence();
      // filet de sécurité : des modifications peuvent ne pas être encore enregistrées
      if (isAdmin() && hasUnsaved()) { e.preventDefault(); e.returnValue = ""; return ""; }
    });
    document.addEventListener("visibilitychange", function () {
      // Seul un admin rafraîchit sa présence au retour d'onglet ; le public ne
      // fait aucune requête /presence.
      if (isAdmin() && document.visibilityState !== "hidden") presenceTick();
    });
    document.addEventListener("input", function (e) {
      if (!isAdmin() || !e.target || !e.target.closest) return;
      if (e.target.closest("#panel-admin, #logHost, #plannerHost, .modal")) markDirty();
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
        // Si l'onglet Files a déjà été rendu avant la fin du chargement de la
        // config (ouverture directe sur #files), on réévalue l'état de
        // maintenance maintenant que configurator_enabled est connu.
        if (loaded.files && manifest) renderConfigurator();
      })
      .catch(function () { /* placeholders restent affichés */ })
      .then(function () { startPresence(); }); // arme le heartbeat de présence (actif uniquement une fois un admin connecté)
  }

  // Configurateur actif ? false uniquement si un admin l'a explicitement coupé
  // (interrupteur de maintenance). Toute autre valeur (absente, true) = actif.
  function configuratorEnabled() { return config.configurator_enabled !== false; }

  /* ---- numéro de version (barre du haut) ---------------------------------
     Affiche, en orange, la version la plus récente du changelog
     (data/changelog.json). Chargé à l'ouverture du site et réactualisé après
     chaque édition admin du changelog : il suit donc toujours la dernière entrée. */
  function latestVersion(entries) {
    if (!Array.isArray(entries) || !entries.length) return "";
    var top = entries.slice().sort(function (a, b) { return GammaCore.cmpVersion(b.version, a.version); })[0];
    return top && top.version ? String(top.version).trim() : "";
  }
  function setVersionBadge(version) {
    appVersion = version ? String(version).trim() : "";
    var node = $("#brandVer");
    if (!node) return;
    if (version) { node.textContent = "v." + version; node.hidden = false; }
    else { node.textContent = ""; node.hidden = true; }
  }

  // Résout le numéro de version de l'application (celui du badge). Utilise la
  // valeur déjà connue, sinon le changelog en cache, sinon le récupère. Renvoie
  // toujours une Promise<string> (chaîne vide si le changelog est injoignable).
  function currentVersion() {
    if (appVersion) return Promise.resolve(appVersion);
    if (Array.isArray(data.changelog)) return Promise.resolve(latestVersion(data.changelog));
    return fetch("data/changelog.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (entries) {
        var v = latestVersion(Array.isArray(entries) ? entries : "");
        if (v) appVersion = v;
        return v;
      })
      .catch(function () { return ""; });
  }
  function loadVersionBadge() {
    if (Array.isArray(data.changelog)) { setVersionBadge(latestVersion(data.changelog)); return; }
    fetch("data/changelog.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (entries) { setVersionBadge(latestVersion(Array.isArray(entries) ? entries : [])); })
      .catch(function () { /* badge masqué si le changelog est injoignable */ });
  }

  /* ---- présence : compteur d'admins en ligne + indicateur d'édition -------
     Réservé aux admins : seul un admin connecté envoie un heartbeat (ping)
     périodique (avec son état « édition en cours ») et voit le compteur. Un
     visiteur public ne fait AUCUNE requête /presence — économie de quota KV. */
  var PRESENCE_MS = 50000; // heartbeat espacé (< PRESENCE_TTL du Worker) → moins d'écritures KV

  function sessionId() {
    if (!presence.id) presence.id = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    return presence.id;
  }
  function presenceUrl() { return config.worker_url.replace(/\/$/, "") + "/presence"; }

  function presenceTick() {
    // Présence réservée aux admins : un visiteur public ne fait AUCUNE requête.
    if (!workerReady() || !isAdmin()) return;
    var payload = { password: admin.pwd, id: sessionId(), action: "ping", editing: adminDirty };
    fetch(presenceUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { applyPresence(d); })
      .catch(function () { applyPresence(null); });
  }

  // Met à jour le badge à partir de la réponse du Worker — ou de rien (null) si le
  // Worker est injoignable ou ne connaît pas la route /presence (déploiement
  // obsolète → 404, CORS, réseau). Un admin connecté se compte alors toujours au
  // moins lui-même, pour que le compteur reste visible quoi qu'il arrive côté
  // Worker ; le décompte des autres sessions, lui, reste tributaire du Worker + KV.
  function applyPresence(d) {
    d = d || {};
    var count = d.count || 0;
    if (isAdmin() && count < 1) count = 1;
    // « édition en cours » : un autre admin édite (compté par le Worker) OU
    // l'admin courant a lui-même une modification non enregistrée.
    var editing = (d.editing || 0) > 0 || (isAdmin() && adminDirty);
    setPresenceBadge(count, editing);
  }

  function startPresence() {
    if (presence.timer) clearInterval(presence.timer);
    presenceTick(); // ping initial si déjà admin ; sinon no-op (le public ne sollicite jamais le Worker)
    presence.timer = setInterval(function () {
      // Seuls les admins connectés rafraîchissent leur présence (heartbeat), et
      // jamais quand l'onglet est masqué (la présence expire d'elle-même côté
      // Worker). Un visiteur public ne déclenche aucune requête /presence.
      if (!isAdmin()) return;
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
      if (count > 0) { badge.textContent = count; badge.hidden = false; }
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

  /* ---- enregistrement manuel (bouton + filet de sécurité) ----------------
     Chaque éditeur admin possède un bouton « Enregistrer » : rien n'est envoyé
     au Worker tant qu'il n'est pas cliqué (un enregistrement = un commit GitHub).
     Une modification marque l'éditeur « non enregistré » (bouton actif + statut),
     ce qui alimente le filet de sécurité au changement d'onglet / fermeture de
     page (pop-up « modifications en attente »). Plus aucun envoi automatique. */
  var autosavers = [];
  function cancelAutosaves() { autosavers = []; }     // jette les éditeurs (et leurs modifs en attente)
  function resetAutosavers() { cancelAutosaves(); }   // re-render d'un éditeur : repart de zéro
  function hasUnsaved() {
    for (var i = 0; i < autosavers.length; i++) { if (autosavers[i].pending()) return true; }
    return false;
  }
  function flushAutosaves() { autosavers.forEach(function (a) { a.flush(); }); }

  // build() renvoie l'objet à écrire (ou null pour ne rien faire) ; onSuccess(obj)
  // est appelé après un enregistrement réussi (sans recharger l'éditeur). Le
  // gestionnaire fournit son propre bouton « Enregistrer » (mgr.button), actif
  // uniquement tant qu'il reste des modifications non enregistrées.
  function makeSaver(filename, build, status, onSuccess) {
    var dirty = false, saving = false;
    var btn = el("button", { class: "btn btn--green", text: "Enregistrer", disabled: true });
    function save() {
      if (saving || !dirty) return;
      var obj = build();
      if (obj == null) return;
      saving = true;
      saveData(filename, obj, status, btn,
        function () { dirty = false; if (typeof onSuccess === "function") onSuccess(obj); },
        // saveData réactive le bouton ; on rétablit l'état réel (désactivé si plus
        // rien à enregistrer, réactivé en cas d'échec ou de nouvelle saisie).
        function () { saving = false; btn.disabled = !dirty; });
    }
    btn.addEventListener("click", save);
    var mgr = {
      button: btn,
      queue: function () { dirty = true; btn.disabled = false; setStatus(status, "work", "Modifications non enregistrées."); markDirty(); },
      flush: function () { if (dirty) save(); },
      cancel: function () { dirty = false; btn.disabled = true; },
      pending: function () { return dirty || saving; }
    };
    autosavers.push(mgr);
    return mgr;
  }

  // Pied d'éditeur en mode manuel : bouton « Enregistrer » (porté par le
  // gestionnaire) + zone de statut (Modifications non enregistrées… / Enregistré).
  function saveFoot(mgr, status) {
    return el("div", { class: "editor__foot" }, [mgr.button, status]);
  }

  // Liste de champs texte avec « ligne fantôme » : une entrée vide en bas qui
  // crée une nouvelle ligne dès qu'on y tape. Les entrées vides ne sont jamais
  // conservées. arr (tableau de chaînes) est muté en place ; onChange() est
  // appelé après toute modification (typiquement pour relancer l'autosave).
  function renderGhostInputs(container, arr, opts) {
    opts = opts || {};
    var smCls = opts.sm ? " input--sm" : "";
    clear(container);
    arr.forEach(function (val, i) {
      var inp = el("input", { class: "input" + smCls, type: "text", value: val, placeholder: opts.placeholder || "" });
      inp.addEventListener("input", function () { arr[i] = inp.value; if (opts.onChange) opts.onChange(); });
      var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕",
        onClick: function () { arr.splice(i, 1); if (opts.onChange) opts.onChange(); redraw(-1); } });
      container.appendChild(el("div", { class: "editrow" }, [el("div", { class: "editrow__fields" }, [inp]), del]));
    });
    var ghost = el("input", { class: "input input--ghost" + smCls, type: "text", value: "",
      placeholder: opts.ghostPlaceholder || opts.placeholder || "Ajouter…" });
    ghost.addEventListener("input", function () {
      if (ghost.value === "") return;
      arr.push(ghost.value);
      if (opts.onChange) opts.onChange();
      redraw(arr.length - 1); // refocus la nouvelle ligne réelle, curseur en fin
    });
    container.appendChild(el("div", { class: "editrow editrow--ghost" }, [el("div", { class: "editrow__fields" }, [ghost])]));

    function redraw(focusIdx) {
      renderGhostInputs(container, arr, opts);
      if (focusIdx >= 0) {
        var inputs = container.querySelectorAll(".editrow input");
        var t = inputs[focusIdx];
        if (t) { t.focus(); var L = t.value.length; try { t.setSelectionRange(L, L); } catch (_) {} }
      }
    }
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
    var current = tabFromHash() || DEFAULT_TAB;
    if (current === name) { activateTab(name); return; }
    // si une modification admin n'est pas encore enregistrée, proposer un pop-up
    if (isAdmin() && hasUnsaved()) {
      showLeaveGuard(function () { location.hash = name; });
      return;
    }
    location.hash = name; // déclenche hashchange → activateTab
  }

  // Pop-up « modifications en attente » : enregistrer maintenant, ou partir.
  function showLeaveGuard(proceed) {
    var content = el("div", { class: "modal__inner" });
    content.appendChild(el("div", { class: "modal__head" }, [
      el("h3", { class: "modal__title", text: "Modifications en attente" }),
      el("button", { class: "btn btn--ghost btn--icon", title: "Fermer", text: "✕", onClick: closeModal })
    ]));
    content.appendChild(el("div", { class: "modal__body" }, [
      el("p", { text: "Des modifications ne sont pas encore enregistrées. Que veux-tu faire ?" })
    ]));
    content.appendChild(el("div", { class: "modal__foot" }, [
      el("button", { class: "btn btn--ghost", text: "Quitter sans enregistrer", onClick: function () { cancelAutosaves(); closeModal(); proceed(); } }),
      el("button", { class: "btn btn--green", text: "Enregistrer", onClick: function () { flushAutosaves(); closeModal(); proceed(); } })
    ]));
    openModal(content);
  }

  // Pop-up de confirmation générique : titre + message + bouton de validation.
  // onConfirm() n'est appelé que si l'admin clique sur le bouton de validation.
  function showConfirm(opts, onConfirm) {
    opts = opts || {};
    var content = el("div", { class: "modal__inner" });
    content.appendChild(el("div", { class: "modal__head" }, [
      el("h3", { class: "modal__title", text: opts.title || "Confirmation" }),
      el("button", { class: "btn btn--ghost btn--icon", title: "Fermer", text: "✕", onClick: closeModal })
    ]));
    content.appendChild(el("div", { class: "modal__body" }, [
      el("p", { text: opts.message || "Confirmer cette action ?" })
    ]));
    content.appendChild(el("div", { class: "modal__foot" }, [
      el("button", { class: "btn btn--ghost", text: opts.cancelText || "Annuler", onClick: closeModal }),
      el("button", { class: "btn btn--amber", text: opts.confirmText || "Confirmer", onClick: function () { closeModal(); if (typeof onConfirm === "function") onConfirm(); } })
    ]));
    openModal(content);
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
    if (name === "updates") loadUpdates();
    if (name === "admin") loadAdmin();
  }

  // ---- sous-onglets de l'admin ------------------------------------------
  // Range les sections de l'admin dans des panneaux montrés/masqués par une
  // barre de sous-onglets. Purement présentation : tous les panneaux sont déjà
  // construits et peuplés par l'appelant (les chargements async et les
  // autosaveurs sont donc armés quel que soit l'onglet affiché). On reprend le
  // motif ARIA des onglets principaux (rôles tab/tabpanel, flèches clavier).
  // sections : [{ id, label, panel }]. Renvoie { nav, host } à insérer dans le DOM.
  function buildAdminSubtabs(sections) {
    var nav = el("div", { class: "subnav", role: "tablist", "aria-label": "Sections de l'administration" });
    var host = el("div", { class: "subpanels" });
    var btns = [];

    sections.forEach(function (s, i) {
      var first = i === 0;
      s.panel.classList.add("subpanel");
      if (first) s.panel.classList.add("is-active");
      s.panel.id = "adm-panel-" + s.id;
      s.panel.setAttribute("role", "tabpanel");
      s.panel.setAttribute("aria-labelledby", "adm-tab-" + s.id);
      if (!first) s.panel.setAttribute("hidden", "");
      host.appendChild(s.panel);

      var btn = el("button", {
        class: "subnav__btn" + (first ? " is-active" : ""),
        type: "button", role: "tab", id: "adm-tab-" + s.id,
        "aria-controls": "adm-panel-" + s.id,
        "aria-selected": first ? "true" : "false",
        tabindex: first ? "0" : "-1",
        text: s.label
      });
      btns.push(btn);
      nav.appendChild(btn);
    });

    function activate(idx) {
      btns.forEach(function (b, j) {
        var on = j === idx;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      sections.forEach(function (s, j) {
        var on = j === idx;
        s.panel.classList.toggle("is-active", on);
        if (on) s.panel.removeAttribute("hidden"); else s.panel.setAttribute("hidden", "");
      });
    }

    btns.forEach(function (btn, i) {
      btn.addEventListener("click", function () { activate(i); });
      btn.addEventListener("keydown", function (ev) {
        var idx = -1;
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") idx = (i + 1) % btns.length;
        else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") idx = (i - 1 + btns.length) % btns.length;
        else if (ev.key === "Home") idx = 0;
        else if (ev.key === "End") idx = btns.length - 1;
        else return;
        ev.preventDefault();
        btns[idx].focus();
        activate(idx);
      });
    });

    return { nav: nav, host: host };
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
    resetAutosavers();
    var b = data.board || normalizeBoard(null);

    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition du panneau d'affichage — modifie puis enregistre." })
    ]));

    var card = el("div", { class: "card" });
    var title = el("input", { class: "input", type: "text", value: b.title, placeholder: "Titre de l'annonce…" });
    var body = el("textarea", { class: "textarea", rows: "6", placeholder: "Texte affiché en haut de l'accueil…" });
    body.value = b.body;
    card.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Titre" }), title]));
    card.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Message" }), body]));

    var status = el("span", { class: "editor__status" });
    var mgr = makeSaver("board.json", function () {
      var today = new Date();
      return {
        title: title.value.trim(),
        body: body.value.trim(),
        updated: today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate())
      };
    }, status, function (obj) { data.board = normalizeBoard(obj); });
    title.addEventListener("input", mgr.queue);
    body.addEventListener("input", mgr.queue);
    card.appendChild(saveFoot(mgr, status));
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
      if (c && c.archive) return; // les tickets archivés ne remontent pas dans les nouveautés
      (c.tickets || []).forEach(function (t) {
        if (!t || !(t.title || "").trim()) return;
        var modified = t.modified || t.created || "";
        var day = dayOf(modified);
        if (!day) return;
        var created = t.created || "";
        out.push({
          day: day, stamp: modified, title: t.title, category: (c.name || "").trim(),
          isNew: !created || modified === created,
          // actions de la tâche, état coché compris : reprises telles quelles dans
          // les nouveautés (carré vide « à faire » / carré coché « fait »).
          actions: (Array.isArray(t.actions) ? t.actions : [])
            .filter(function (a) { return a && (a.text || "").trim(); })
            .map(function (a) { return { text: String(a.text), done: !!a.done }; })
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
        renderChangelogDay(newsSection(host, "Changelog — modifications du " + fmtDateOnly(clDay)),
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
        renderPlannerDay(newsSection(host, "Planner — modifications du " + fmtDateOnly(plDay)),
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
          el("span", { class: "log-entry__ver", text: "v." + (e.version || "?") }),
          (e.date && dayOf(e.date) !== day) ? el("span", { class: "log-entry__date", text: fmtDateOnly(e.date) }) : null
        ]);
        var ul = el("ul", { class: "log-entry__changes" });
        (e.changes || []).forEach(function (c) { ul.appendChild(el("li", { text: c })); });
        box.appendChild(el("div", { class: "log-entry" }, [head, ul]));
      });
  }

  function renderPlannerDay(box, items) {
    var ul = el("ul", { class: "log-entry__changes log-entry__changes--planner" });
    items
      .slice()
      .sort(function (a, b) { return a.stamp < b.stamp ? 1 : -1; })
      .forEach(function (n) {
        var label = (n.isNew ? "Nouvelle tâche : " : "Tâche mise à jour : ") + n.title + (n.category ? " — " + n.category : "");
        var item = el("div", { class: "board-news__task" }, [el("span", { class: "board-news__tasklabel", text: label })]);
        // Reprend la checklist de la tâche avec le même visuel que sur le ticket :
        // un carré vide pour les actions à faire, un carré coché pour celles cochées.
        if (n.actions && n.actions.length) {
          var acts = el("div", { class: "pchecks board-news__acts" });
          n.actions.forEach(function (a) {
            acts.appendChild(el("div", { class: "pcheck" + (a.done ? " is-done" : "") }, [
              el("span", { class: "pcheck__box", text: a.done ? "✓" : "" }),
              el("span", { class: "pcheck__text", text: a.text })
            ]));
          });
          item.appendChild(acts);
        }
        ul.appendChild(el("li", {}, [item]));
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
  // Tri « naturel » des patchs par libellé affiché (numéro de dossier compris) :
  // 1, 2, … 9, 10, … 90, … 200 — et non l'ordre lexicographique (« 200 » avant
  // « 90 »). Renvoie une copie triée, sans altérer le manifeste.
  function sortPatchesByName(list) {
    return (list || []).slice().sort(function (a, b) {
      return GammaCore.cmpNatural(a.name || a.id, b.name || b.id);
    });
  }
  function availablePatches(level) {
    if (!manifest) return [];
    if (level === "tweak") return sortPatchesByName(manifest.tweak).map(tagSection("Tweak"));
    if (level === "extra") return sortPatchesByName(manifest.tweak).map(tagSection("Tweak"))
      .concat(sortPatchesByName(manifest.extra).map(tagSection("Extra")));
    return [];
  }
  // Patchs d'une étape de sélection donnée (sections « Tweak » et « Extra »
  // dissociées en deux étapes distinctes du configurateur).
  function patchesForStep(stepName) {
    if (!manifest) return [];
    if (stepName === "Patch Tweak") return sortPatchesByName(manifest.tweak).map(tagSection("Tweak"));
    if (stepName === "Patch Extra") return sortPatchesByName(manifest.extra).map(tagSection("Extra"));
    return [];
  }
  function stepNames() {
    if (conf.level === "extra") return ["Niveau", "Patch Tweak", "Patch Extra", "Récapitulatif"];
    if (conf.level === "tweak") return ["Niveau", "Patch Tweak", "Récapitulatif"];
    if (conf.level === "base") return ["Niveau", "Récapitulatif"];
    return ["Niveau"];
  }
  function baseName(path) { return GammaCore.baseName(path); }
  function encPath(path) { return String(path).split("/").map(encodeURIComponent).join("/"); }

  // ---- rendu --------------------------------------------------------------
  // Bandeau de maintenance affiché à la place du configurateur quand un admin
  // l'a désactivé (plus aucun téléchargement possible).
  function renderMaintenanceNotice() {
    return el("div", { class: "maintenance", role: "status", "aria-live": "polite" }, [
      el("span", { class: "maintenance__tag", text: "MAINTENANCE" }),
      el("span", { class: "maintenance__msg", text: "Configurateur désactivé" })
    ]);
  }

  function renderConfigurator() {
    var host = $("#wizard");
    clear(host);

    // Interrupteur de maintenance (admin) : configurateur coupé → message, pas
    // de wizard ni de téléchargement.
    if (!configuratorEnabled()) {
      host.appendChild(renderMaintenanceNotice());
      return;
    }

    var names = stepNames();
    if (conf.step >= names.length) conf.step = names.length - 1;

    host.appendChild(renderStepMarkers(names));

    var card = el("div", { class: "card" });
    var cur = names[conf.step];
    if (cur === "Niveau") card.appendChild(renderLevelStep());
    else if (cur === "Patch Tweak") card.appendChild(renderPatchStep(patchesForStep("Patch Tweak"), {
      title: "Patchs Tweak",
      sub: "Coche les patchs Tweak à inclure. GAMMA base est déjà incluse."
    }));
    else if (cur === "Patch Extra") card.appendChild(renderPatchStep(patchesForStep("Patch Extra"), {
      title: "Patchs Extra",
      sub: "Coche les patchs Extra (mods externes à G.A.M.M.A.) à inclure.",
      empty: "Aucun patch Extra disponible pour le moment."
    }));
    else card.appendChild(renderRecapStep());
    host.appendChild(card);

    // Étapes de sélection (longues listes de patchs) : on double la navigation
    // dans deux bulles flottantes — « Retour » à gauche, « Suivant » à droite —
    // pour qu'elle reste atteignable n'importe où dans la liste sans descendre
    // tout en bas. Sur écran étroit, ces bulles sont masquées (CSS) et la barre
    // d'actions du bas prend le relais.
    var actions = renderActions(names);
    if (cur === "Patch Tweak" || cur === "Patch Extra") {
      actions.classList.add("wizard-actions--has-side");
      host.appendChild(actions);
      host.appendChild(renderSideNav(names, "left"));
      host.appendChild(renderSideNav(names, "right"));
    } else {
      host.appendChild(actions);
    }
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
      // Compteur de patchs disponibles affiché sous chaque niveau. « extra »
      // inclut tout le contenu « tweak » : on l'exprime « G.A.M.M.A. tweak + N »
      // (N = patchs extra uniquement) plutôt que d'additionner les deux en un
      // seul nombre, qui laisserait croire que « extra » possède ses propres
      // patchs tweak.
      var countText = "";
      if (lv.id === "tweak") {
        var nTweak = manifest.tweak.length;
        countText = " (" + nTweak + " patch" + (nTweak > 1 ? "s" : "") + " dispo)";
      } else if (lv.id === "extra") {
        var nExtra = manifest.extra.length;
        countText = " (G.A.M.M.A. tweak + " + nExtra + " patch" + (nExtra > 1 ? "s" : "") + " dispo)";
      }
      var row = el("div", {
        class: "opt" + (checked ? " is-checked" : ""), "data-type": "single",
        role: "radio", "aria-checked": checked ? "true" : "false", tabindex: "0"
      }, [
        el("span", { class: "opt__mark" }),
        el("div", { class: "opt__body" }, [
          el("div", { class: "opt__label", text: lv.label }),
          // Texte descriptif du niveau en blanc (couleur du titre) ; le compteur
          // garde sa teinte atténuée via .opt__count. Le modifieur --level cible
          // ces seules descriptions (les patchs réutilisent .opt__desc atténué).
          el("div", { class: "opt__desc opt__desc--level" }, [
            lv.desc,
            countText ? el("span", { class: "opt__count", text: countText }) : null
          ])
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

  function renderPatchStep(patches, opts) {
    opts = opts || {};
    patches = patches || [];
    var frag = document.createDocumentFragment();

    frag.appendChild(el("div", { class: "step-head" }, [el("h3", { class: "step-title", text: opts.title || "Patchs" })]));
    frag.appendChild(el("p", { class: "step-sub", text: opts.sub || "Coche les patchs à inclure. GAMMA base est déjà incluse." }));

    var input = el("input", { class: "input", type: "search", placeholder: "Filtrer les patchs\u2026", "aria-label": "Filtrer les patchs" });
    var count = el("div", { class: "search__count" });
    frag.appendChild(el("div", { class: "search" }, [el("span", { class: "search__icon", text: "\u2315" }), input, count]));

    var listBox = el("div", { class: "options" });
    frag.appendChild(listBox);

    if (!patches.length) {
      listBox.appendChild(el("p", { class: "list-empty", text: opts.empty || "Aucun patch disponible dans ce niveau." }));
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
    if (p.url) bodyChildren.push(el("a", { class: "opt__link", href: p.url, target: "_blank", rel: "noopener noreferrer", text: "\u2197 " + p.url }));

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

    // Patchs sélectionnés, regroupés par section avec des séparateurs :
    // « G.A.M.M.A. base » (toujours incluse), « Patchs G.A.M.M.A. tweak » puis
    // « Patchs G.A.M.M.A. extra ». Les sections tweak/extra ne s'affichent
    // qu'aux niveaux qui les proposent.
    var pg = el("div", { class: "recap__group" }, [el("div", { class: "recap__h", text: "Patchs sélectionnés" })]);
    function recapSection(title, items, emptyLabel) {
      pg.appendChild(el("div", { class: "recap__sep", text: title }));
      if (items.length) {
        var ul = el("ul", { class: "recap__list" });
        items.forEach(function (p) {
          ul.appendChild(el("li", { class: "recap__item", text: (p.name || p.id) + (p.version ? " \u00b7 v" + p.version : "") }));
        });
        pg.appendChild(ul);
      } else {
        pg.appendChild(el("div", { class: "recap__empty", text: emptyLabel }));
      }
    }

    pg.appendChild(el("div", { class: "recap__sep", text: "G.A.M.M.A. base" }));
    pg.appendChild(el("ul", { class: "recap__list" }, [el("li", { class: "recap__item", text: "Toujours incluse" })]));
    if (r.level === "tweak" || r.level === "extra") {
      recapSection("Patchs G.A.M.M.A. tweak", r.patches.filter(function (p) { return p._section === "Tweak"; }), "Aucun");
    }
    if (r.level === "extra") {
      recapSection("Patchs G.A.M.M.A. extra", r.patches.filter(function (p) { return p._section === "Extra"; }), "Aucun");
    }
    recap.appendChild(pg);

    if (r.warnings.length) {
      recap.appendChild(el("div", { class: "notice is-shown notice--err", text: r.warnings.length + " conflit(s) de priorité (" + r.warnings.join(", ") + ") \u2014 fixe des priorités distinctes pour lever l'ambiguïté." }));
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
  // Boutons de navigation, réutilisés par la barre du bas et le bloc flottant.
  function navBackBtn() {
    var back = el("button", { class: "btn btn--ghost", text: "\u25C2 Retour",
      onClick: function () { if (conf.step > 0) { conf.step--; renderConfigurator(); } } });
    back.disabled = conf.step === 0;
    return back;
  }
  function navNextBtn(names) {
    var next = el("button", { class: "btn", text: "Suivant \u25B8",
      onClick: function () { conf.step++; renderConfigurator(); } });
    if (names[conf.step] === "Niveau") next.disabled = !conf.level;
    return next;
  }
  // Bulle de navigation flottante (révélée par CSS sur grand écran) : « Retour »
  // est ancré à gauche de la colonne, « Suivant » à droite, pour rester
  // accessible n'importe où dans la liste sans descendre tout en bas.
  function renderSideNav(names, pos) {
    var bubble = el("div", { class: "wizard-side wizard-side--" + pos });
    bubble.appendChild(pos === "left" ? navBackBtn() : navNextBtn(names));
    return bubble;
  }
  function renderActions(names) {
    var actions = el("div", { class: "wizard-actions" });
    actions.appendChild(navBackBtn());

    if (names[conf.step] === "Récapitulatif") {
      actions.appendChild(el("button", { class: "btn", text: "Générer l'archive \u25BE", onClick: assembleAndDownload }));
    } else {
      actions.appendChild(navNextBtn(names));
    }
    return actions;
  }

  /* ---- meta.ini de l'archive ----------------------------------------------
     Mod Organizer 2 lit ce fichier à la racine du mod pour afficher la version
     (colonne « Version ») et les métadonnées. Le numéro de version est celui de
     l'application (dernière entrée du changelog = badge de la barre du haut),
     jamais saisi à la main. */
  // Encode une chaîne en octets UTF-8 (meta.ini ; GammaZip n'expose pas son
  // propre encodeur). Repli minimal si TextEncoder est absent.
  function strBytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(bytes);
  }

  function buildMetaIni(version, fileName) {
    var lines = [
      "[General]",
      "gameName=stalkeranomaly",
      "modid=0",
      "version=" + (version || ""),
      "newestVersion=" + (version || ""),
      "ignoredVersion=",
      "category=0",
      "nexusFileStatus=1",
      "installationFile=" + (fileName || ""),
      "repository=",
      "author=" + (config.mod_author || ""),
      "comments=" + (config.site_title || "GAMMA.FR") + (config.site_tagline ? " — " + config.site_tagline : ""),
      "notes=" + (config.site_tagline || ""),
      "url=" + (config.site_url || ""),
      "hasCustomURL=true",
      "converted=false",
      "validated=false",
      "tracked=0"
    ];
    return lines.join("\r\n") + "\r\n";
  }

  /* ---- info.xml du FOMOD ----------------------------------------------------
     L'installeur FOMOD de Mod Organizer 2 recrée le meta.ini du mod À PARTIR de
     ce fomod/info.xml : il écrase donc le meta.ini qu'on ajoute à la racine.
     Pour que les métadonnées survivent, on les injecte aussi dans info.xml au
     moment de l'assemblage (Name/Author/Version/Website). Le fichier est fourni
     par MainFile en UTF-16LE (avec BOM) : on le relit, on remplace les champs,
     puis on le réencode en UTF-16LE pour préserver son format d'origine. */
  function utf16leToStr(bytes) {
    var start = (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) ? 2 : 0;
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-16le").decode(bytes.subarray(start));
    var out = "";
    for (var i = start; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return out;
  }
  // Encode une chaîne en octets UTF-16LE précédés du BOM (TextEncoder ne sait
  // faire que de l'UTF-8 ; on écrit donc chaque code unit, octet faible en tête).
  function strBytesUtf16le(str) {
    var out = new Uint8Array(2 + str.length * 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      out[2 + i * 2] = c & 0xFF;
      out[2 + i * 2 + 1] = (c >> 8) & 0xFF;
    }
    return out;
  }
  function xmlEscape(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Remplace le contenu de <tag>…</tag> (laisse le fichier intact si le tag est absent).
  function setXmlField(xml, tag, value) {
    var re = new RegExp("(<" + tag + ">)[\\s\\S]*?(</" + tag + ">)");
    return xml.replace(re, function (m, open, close) { return open + xmlEscape(value) + close; });
  }
  function patchInfoXml(bytes, meta) {
    var xml = utf16leToStr(bytes);
    xml = setXmlField(xml, "Name", meta.name);
    xml = setXmlField(xml, "Author", meta.author);
    xml = setXmlField(xml, "Version", meta.version);
    xml = setXmlField(xml, "Website", meta.website);
    return strBytesUtf16le(xml);
  }

  /* ---- frites_version.xml (version du MCM « À propos ») ----------------------
     Le MCM de F.R.I.T.E.S affiche la version installée dans son onglet « À propos »
     (<string id="ui_mcm_frites_about_version">). Cette balise est isolée dans son
     propre fichier frites_version.xml — dissociée de frites_mcm.xml — afin que
     l'assemblage ne réécrive QUE ce fichier (pur ASCII) et ne touche jamais à
     frites_mcm.xml, qui conserve ainsi à l'identique ses caractères accentués
     windows-1252 (plus aucun risque de réencodage). On y injecte, à l'assemblage,
     la même version que meta.ini / fomod/info.xml (dernière entrée du changelog),
     au lieu d'un numéro figé. Le fichier est fourni en windows-1252 (sans BOM) : on
     le manipule octet par octet (chaque octet ↔ un point de code 0–255), le texte
     injecté étant pur ASCII. */
  function bytesToBinStr(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function binStrToBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
  }
  // Ajoute le numéro de version à la fin du <text>…</text> de la balise
  // « about_version », en conservant son contenu tel quel (dont le code couleur
  // %c[d_orange]). Laisse le fichier intact si la balise est absente.
  function patchVersionFile(bytes, version) {
    var xml = bytesToBinStr(bytes);
    var re = /(<string\s+id="ui_mcm_frites_about_version">[\s\S]*?<text>)([\s\S]*?)(<\/text>)/;
    if (!re.test(xml)) return bytes;
    xml = xml.replace(re, function (m, open, inner, close) { return open + inner + xmlEscape(version) + close; });
    return binStrToBytes(xml);
  }

  // ---- assemblage du ZIP --------------------------------------------------
  function assembleAndDownload() {
    var zone = $("#dlZone");
    if (!zone || !manifest) return;
    clear(zone);

    // Filet de sécurité : si la maintenance a été activée entre-temps, on refuse
    // le téléchargement même si le bouton était encore affiché.
    if (!configuratorEnabled()) {
      zone.appendChild(el("p", { class: "notice is-shown notice--err", text: "MAINTENANCE : Configurateur désactivé" }));
      renderConfigurator();
      return;
    }

    if (typeof window.GammaZip === "undefined") {
      zone.appendChild(el("p", { class: "notice is-shown notice--err", text: "Module ZIP non chargé (js/zip.js)." }));
      return;
    }

    var r = resolveSelection();
    var zipName = (config.mod_zip_name || "GAMMAFR-PatchVF") + ".zip";
    var metaVersion = "";   // résolu avant la compression (version de l'app)
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

    // Téléchargement parallèle borné : plutôt qu'un fichier à la fois, un petit
    // pool de requêtes concurrentes tire dans la même liste. Le navigateur garde
    // ainsi plusieurs requêtes en vol (HTTP/2 multiplexe sur une seule connexion),
    // ce qui réduit fortement le temps total — dominé par la latence réseau quand
    // l'archive compte des centaines de fichiers. L'écriture par index préserve
    // l'ordre des entrées dans le ZIP (identique à la version séquentielle).
    var DL_CONCURRENCY = 8, DL_ATTEMPTS = 3, DL_BACKOFF_MS = 300;
    var entries = new Array(total), done = 0, nextIdx = 0, failed = [];
    function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
    // Récupère un fichier avec quelques tentatives : sur des centaines de fichiers,
    // un aléa réseau ponctuel ne doit pas faire échouer toute l'archive. On ré-essaie
    // avec un délai croissant (backoff exponentiel). Les erreurs définitives
    // (404/403 : fichier réellement absent) ne sont pas ré-essayées — inutile.
    function fetchBytes(src, attempt) {
      return fetch(encPath(src), { cache: "no-store" })
        .then(function (resp) {
          if (!resp.ok) { var e = new Error("HTTP " + resp.status); e.permanent = (resp.status === 404 || resp.status === 403); throw e; }
          return resp.arrayBuffer();
        })
        .catch(function (e) {
          if ((e && e.permanent) || attempt >= DL_ATTEMPTS) throw e;
          return wait(DL_BACKOFF_MS * Math.pow(2, attempt - 1)).then(function () { return fetchBytes(src, attempt + 1); });
        });
    }
    function pump() {
      if (nextIdx >= total) return Promise.resolve();
      var i = nextIdx++;
      var target = list[i], src = targets[target];
      return fetchBytes(src, 1)
        .then(function (ab) { entries[i] = { name: target, data: new Uint8Array(ab) }; })
        .catch(function () { failed.push(src); })
        .then(function () {
          done++;
          bar.style.width = Math.round((done / total) * 100) + "%";
          status.textContent = "Téléchargement des fichiers\u2026 " + done + " / " + total;
          return pump();
        });
    }
    function downloadAll() {
      var pool = [];
      for (var k = 0; k < Math.min(DL_CONCURRENCY, total); k++) pool.push(pump());
      return Promise.all(pool);
    }

    function finish() {
      if (failed.length) {
        status.className = "notice is-shown notice--err";
        status.textContent = failed.length + " fichier(s) introuvable(s). Vérifie que 0. PatchVF est publié sur le site. Premier échec : " + failed[0];
        return;
      }
      // meta.ini ajout\u00e9 \u00e0 la racine de l'archive, sauf si MainFile en fournit
      // d\u00e9j\u00e0 un (on n'\u00e9crase pas un fichier fourni \u00e0 la main).
      var hasMeta = entries.some(function (e) { return e.name.toLowerCase() === "meta.ini"; });
      if (!hasMeta) {
        entries.push({ name: "meta.ini", data: strBytes(buildMetaIni(metaVersion, zipName)) });
      }
      // fomod/info.xml : on injecte les m\u00e9tadonn\u00e9es lues par l'installeur FOMOD
      // (qui recr\u00e9e le meta.ini \u00e0 partir de ce fichier, \u00e9crasant le n\u00f4tre).
      var infoEntry = entries.filter(function (e) {
        return e.name.toLowerCase().replace(/\\/g, "/") === "fomod/info.xml";
      })[0];
      if (infoEntry) {
        infoEntry.data = patchInfoXml(infoEntry.data, {
          name: config.mod_zip_name || "",
          author: config.mod_author || "",
          version: metaVersion || "",
          website: config.site_url || ""
        });
      }
      // gamedata/.../frites_version.xml : le MCM affiche la version dans \u00ab \u00c0 propos \u00bb.
      // On y injecte la m\u00eame version (derni\u00e8re changelog) que meta.ini / info.xml.
      // frites_mcm.xml (textes accentu\u00e9s) n'est jamais touch\u00e9 par l'assemblage.
      if (metaVersion) {
        var versionEntry = entries.filter(function (e) {
          return baseName(e.name).toLowerCase() === "frites_version.xml";
        })[0];
        if (versionEntry) versionEntry.data = patchVersionFile(versionEntry.data, metaVersion);
      }
      status.textContent = "Compression\u2026";
      window.GammaZip.create(entries).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = el("a", { href: url, download: zipName });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        countArchiveDownload(); // stats jour/mois/total (onglet Admin), best-effort
        setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
        status.className = "notice is-shown notice--ok";
        clear(status);
        status.appendChild(document.createTextNode("Archive prête : "));
        status.appendChild(el("a", { href: url, download: zipName, class: "dl__relink", text: zipName }));
        status.appendChild(document.createTextNode("  (" + total + " fichiers" + (metaVersion ? ", v" + metaVersion : "") + ")."));
      }).catch(function (e) {
        status.className = "notice is-shown notice--err";
        status.textContent = "Échec de la compression : " + e.message;
      });
    }

    // Résout d'abord la version de l'application (pour le meta.ini), puis lance
    // le téléchargement des fichiers.
    currentVersion().then(function (v) { metaVersion = v || ""; downloadAll().then(finish); });
  }

  /* =======================================================================
     ONGLET LISTE — généré automatiquement depuis les patchs « GAMMA extra »
     (data/patches.json). Lecture seule, dans l'ordre des dossiers : on affiche
     le nom, la version, la date et l'URL. Aucune saisie manuelle.
     ======================================================================= */
  function loadListe() {
    var host = $("#listeHost");
    if (data.liste !== null) { renderListe(); return; }
    fetchJSON("data/patches.json")
      .then(function (manifest) {
        data.liste = (manifest && Array.isArray(manifest.extra)) ? sortPatchesByName(manifest.extra) : [];
        renderListe();
      })
      .catch(function (e) {
        loadError(host, "Impossible de charger la liste (" + e.message + ").", loadListe);
      });
  }

  // Date « YYYY-MM-DD » -> « JJ/MM/AAAA » (sans heure). Renvoie la
  // valeur brute si le format ne correspond pas.
  function fmtDateOnly(iso) {
    if (!iso) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : String(iso);
  }

  // Normalise une date vers l'ISO YYYY-MM-DD (format des <input type="date">) :
  // l'ISO est conservé, le format français JJ/MM/AAAA est converti, tout autre
  // format reste tel quel (aucune perte de données).
  function toISODate(s) {
    s = String(s || "").trim();
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + "-" + m[2] + "-" + m[1];
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  }

  function renderListe() {
    var host = $("#listeHost");
    clear(host);
    var entries = data.liste || [];

    var input = el("input", { class: "input", type: "search", placeholder: "Filtrer par nom\u2026", "aria-label": "Rechercher" });
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
        var name = it.name || it.id || "";
        if (needle && name.toLowerCase().indexOf(needle) === -1) return;
        shown++;
        var meta = [];
        if (it.version) meta.push("v" + it.version);
        if (it.date) meta.push(fmtDateOnly(it.date));
        var body = [el("div", { class: "list-item__title", text: name })];
        if (meta.length) body.push(el("div", { class: "list-item__desc", text: meta.join(" \u00b7 ") }));
        if (it.url) {
          var link = el("a", { class: "list-item__link", href: it.url, target: "_blank", rel: "noopener noreferrer", text: it.url });
          // en mode admin, le clic sur le lien ne doit pas ouvrir l'\u00e9diteur
          link.addEventListener("click", function (e) { e.stopPropagation(); });
          body.push(link);
        }
        var children = [
          el("div", { class: "list-item__num", text: pad(shown) }),
          el("div", { class: "list-item__body" }, body)
        ];
        // \u00e9dition r\u00e9serv\u00e9e aux admins : la ligne devient un bouton ouvrant la modale
        var editable = isAdmin() && it.id;
        if (editable) children.push(el("div", { class: "list-item__edit", text: "\u270e", "aria-hidden": "true" }));
        var item = el("div", { class: "list-item" + (editable ? " list-item--editable" : "") }, children);
        if (editable) {
          item.setAttribute("role", "button");
          item.setAttribute("tabindex", "0");
          item.title = "\u00c9diter patch.json";
          item.addEventListener("click", function () { openPatchEditor(it); });
          item.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPatchEditor(it); }
          });
        }
        listBox.appendChild(item);
      });
      if (!shown) listBox.appendChild(el("div", { class: "list-empty", text: entries.length ? "Aucune entrée ne correspond." : "Aucun patch GAMMA extra pour le moment." }));
      count.textContent = shown + " / " + entries.length + " entrée" + (entries.length > 1 ? "s" : "");
    }
    input.addEventListener("input", function () { paint(input.value); });
    paint("");
  }

  // Modale d'édition du patch.json d'un mod de la liste (admin uniquement).
  // Même jeu de champs que le générateur de l'onglet Admin, mais enregistrement
  // réel via le Worker (chargement autoritatif + SHA pour verrouillage optimiste).
  function openPatchEditor(entry) {
    if (!isAdmin() || !entry || !entry.id) return;
    // l'onglet Liste n'affiche que les patchs « GAMMA extra »
    var filename = "0. PatchVF/GAMMA extra/" + entry.id + "/patch.json";

    var content = el("div", { class: "modal__inner" });
    content.appendChild(el("div", { class: "modal__head" }, [
      el("h3", { class: "modal__title", text: "Éditer patch.json" }),
      el("button", { class: "btn btn--ghost btn--icon", title: "Fermer", text: "✕", onClick: closeModal })
    ]));
    var body = el("div", { class: "modal__body" });
    content.appendChild(body);

    body.appendChild(el("p", { class: "admin-note", text:
      "Dossier : 0. PatchVF/GAMMA extra/" + entry.id + "/. Après enregistrement, la liste se met à jour lorsque GitHub régénère data/patches.json (court délai)." }));

    var fName = el("input", { class: "input", type: "text", placeholder: "Dialogues crus" });
    var fDesc = el("textarea", { class: "textarea", rows: "3", placeholder: "Registre familier et vulgaire pour les dialogues PNJ…" });
    var fUrl  = el("input", { class: "input", type: "text", placeholder: "https://www.moddb.com/mods/…" });
    var fPrio = el("input", { class: "input", type: "number", inputmode: "numeric", value: "50" });
    var fDate = el("input", { class: "input", type: "date" });
    var fVer  = el("input", { class: "input", type: "text", placeholder: "1.0.0" });

    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Nom" }), fName]));
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label" }, ["Description ", el("span", { class: "field__opt", text: "facultatif" })]), fDesc]));
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label" }, ["URL ", el("span", { class: "field__opt", text: "facultatif" })]), fUrl]));
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label" }, ["Priorité ", el("span", { class: "field__opt", text: "le plus haut gagne" })]), fPrio]));
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Date" }), fDate]));
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Version" }), fVer]));

    var inputs = [fName, fDesc, fUrl, fPrio, fDate, fVer];
    function setEnabled(on) { inputs.forEach(function (i) { i.disabled = !on; }); }
    setEnabled(false);

    var status = el("span", { class: "editor__status" });
    var saveBtn = el("button", { class: "btn btn--green", text: "Enregistrer", disabled: true });

    // pré-remplissage depuis le fichier (source autoritative) + SHA mémorisé pour
    // le verrouillage optimiste lors de l'enregistrement
    setStatus(status, "work", "Chargement…");
    loadForEdit(filename).then(function (r) {
      var o = r.obj || {};
      fName.value = o.name != null ? o.name : (entry.name || "");
      fDesc.value = o.description != null ? o.description : (entry.description || "");
      fUrl.value  = o.url != null ? o.url : (entry.url || "");
      fPrio.value = o.priority != null ? o.priority : (entry.priority != null ? entry.priority : 50);
      fDate.value = o.date != null ? o.date : (entry.date || "");
      fVer.value  = o.version != null ? o.version : (entry.version || "");
      setEnabled(true);
      saveBtn.disabled = false;
      setStatus(status, "", "");
      fName.focus();
    }).catch(function (e) {
      setStatus(status, "err", "Chargement impossible (" + e.message + ").");
    });

    saveBtn.addEventListener("click", function () {
      var name = fName.value.trim();
      if (!name) { setStatus(status, "err", "Renseigne au moins le nom du patch."); return; }
      var prio = parseInt(fPrio.value, 10); if (isNaN(prio)) prio = 0;
      var obj = {
        name: name,
        description: fDesc.value.trim(),
        date: fDate.value.trim(),
        version: fVer.value.trim(),
        url: fUrl.value.trim(),
        priority: prio
      };
      saveData(filename, obj, status, saveBtn, function () {
        // reflète immédiatement la modification dans la liste affichée
        entry.name = obj.name; entry.description = obj.description; entry.date = obj.date;
        entry.version = obj.version; entry.url = obj.url; entry.priority = obj.priority;
        renderListe();
      });
    });

    content.appendChild(el("div", { class: "modal__foot" }, [saveBtn, status]));
    openModal(content);
  }

  /* =======================================================================
     ONGLET CHANGELOG — lecture (versions décroissantes) + édition admin
     ======================================================================= */
  function loadChangelog() {
    var host = $("#logHost");
    if (data.changelog !== null) { renderChangelog(); return; }
    fetchJSON("data/changelog.json")
      .then(function (entries) { data.changelog = Array.isArray(entries) ? entries : []; setVersionBadge(latestVersion(data.changelog)); renderChangelog(); })
      .catch(function (e) {
        loadError(host, "Impossible de charger le changelog (" + e.message + ").", loadChangelog);
      });
  }

  function renderChangelog() {
    if (!isAdmin()) { renderChangelogReadonly(); return; }
    var host = $("#logHost");
    clear(host); host.appendChild(el("span", { class: "loading", text: "Chargement…" }));
    loadForEdit("changelog.json")
      .then(function (r) { data.changelog = Array.isArray(r.obj) ? r.obj : []; setVersionBadge(latestVersion(data.changelog)); renderChangelogEditor(); })
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
        el("span", { class: "log-entry__ver", text: "v." + (e.version || "?") }),
        e.date ? el("span", { class: "log-entry__date", text: fmtDateOnly(e.date) }) : null
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
    resetAutosavers();
    // Brouillon : chaque version DÉJÀ enregistrée est verrouillée (non modifiable)
    // par défaut ; un bouton « Modifier » la déverrouille. Les versions ajoutées
    // pendant la session sont éditables d'emblée.
    var draft = (data.changelog || []).map(function (e) {
      return { version: e.version || "", date: toISODate(e.date || ""), changes: (e.changes || []).slice(), locked: true };
    });

    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition du changelog — modifie puis enregistre (plus d'enregistrement automatique)." })
    ]));

    var status = el("span", { class: "editor__status" });
    var saveBtn = el("button", { class: "btn btn--green", text: "Enregistrer", disabled: true });

    // Journal nettoyé à partir du brouillon : on ignore les versions sans numéro.
    function build() {
      return draft
        .filter(function (e) { return (e.version || "").trim() !== ""; })
        .map(function (e) {
          return {
            version: e.version.trim(),
            date: (e.date || "").trim(),
            changes: e.changes.map(function (c) { return (c || "").trim(); }).filter(Boolean)
          };
        });
    }

    // Suivi des modifications non enregistrées : active le bouton « Enregistrer »
    // et alimente le filet de sécurité au changement d'onglet / fermeture (via le
    // registre d'autosavers, partagé avec les éditeurs à enregistrement auto).
    var dirty = false;
    function setDirty() {
      dirty = true;
      saveBtn.disabled = false;
      setStatus(status, "work", "Modifications non enregistrées.");
      markDirty();
    }
    function persist(reRender) {
      var obj = build();
      saveData("changelog.json", obj, status, saveBtn, function () {
        dirty = false;
        data.changelog = obj;
        setVersionBadge(latestVersion(obj));
        if (reRender) renderChangelogEditor(); // tout est ré-affiché verrouillé
      });
    }
    autosavers.push({
      flush: function () { if (dirty) persist(false); },
      cancel: function () { dirty = false; },
      pending: function () { return dirty; }
    });

    // Bouton « Ajouter une version » EN HAUT, avant la liste des versions.
    var add = el("button", { class: "btn btn--ghost", text: "+ Ajouter une version",
      onClick: function () {
        // Préremplit le numéro avec le jour au format AA.MMJJ (ex. 26.0618) et la
        // date avec le jour au format ISO YYYY-MM-DD (calendrier <input type=date>).
        var d = new Date(), mm = pad(d.getMonth() + 1), dd = pad(d.getDate());
        draft.unshift({
          version: String(d.getFullYear()).slice(-2) + "." + mm + dd,
          date: d.getFullYear() + "-" + mm + "-" + dd,
          changes: [], locked: false
        });
        setDirty(); drawRows();
      } });
    host.appendChild(el("div", { class: "editor__head" }, [
      el("span", { class: "editor__head-title", text: "Versions" }),
      add
    ]));

    var rows = el("div", { class: "editrows" });
    host.appendChild(rows);

    // Carte verrouill\u00e9e : version, date et modifications en lecture seule, plus un
    // bouton \u00ab Modifier \u00bb qui d\u00e9verrouille l'\u00e9dition de cette seule version.
    function lockedCard(entry) {
      var head = el("div", { class: "editcard__head" }, [
        el("span", { class: "log-entry__ver", text: "v." + (entry.version || "?") }),
        entry.date ? el("span", { class: "log-entry__date", text: fmtDateOnly(entry.date) }) : null,
        el("button", { class: "btn btn--ghost btn--mini editcard__edit", title: "Activer l'\u00e9dition de cette version", text: "Modifier",
          onClick: function () { entry.locked = false; drawRows(); } })
      ]);
      var body;
      if ((entry.changes || []).length) {
        body = el("ul", { class: "log-entry__changes" });
        entry.changes.forEach(function (c) { body.appendChild(el("li", { text: c })); });
      } else {
        body = el("p", { class: "list-empty list-empty--tight", text: "Aucune modification." });
      }
      return el("div", { class: "editcard editcard--locked" }, [head, body]);
    }

    // Carte ouverte : champs \u00e9ditables + lignes de modifications + suppression.
    function openCard(entry, i) {
      var ver = el("input", { class: "input input--sm", type: "text", value: entry.version, placeholder: "Version (26.0618)" });
      ver.addEventListener("input", function () { entry.version = ver.value; setDirty(); });
      var date = el("input", { class: "input input--sm", type: "date", value: toISODate(entry.date), title: "Date de la version" });
      date.addEventListener("input", function () { entry.date = date.value; setDirty(); });
      var delV = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer la version", text: "\u2715",
        onClick: function () { draft.splice(i, 1); setDirty(); drawRows(); } });

      var lines = el("div", { class: "editlines" });
      renderGhostInputs(lines, entry.changes, {
        placeholder: "Modification\u2026",
        ghostPlaceholder: "Ajouter une modification\u2026",
        onChange: setDirty
      });

      return el("div", { class: "editcard" }, [
        el("div", { class: "editcard__head" }, [ver, date, delV]),
        lines
      ]);
    }

    function drawRows() {
      clear(rows);
      draft.forEach(function (entry, i) {
        rows.appendChild(entry.locked ? lockedCard(entry) : openCard(entry, i));
      });
      if (!draft.length) rows.appendChild(el("p", { class: "list-empty", text: "Aucune version. Ajoutes-en une." }));
    }
    drawRows();

    saveBtn.addEventListener("click", function () {
      // Validation avant enregistrement : une version renseignée (date ou
      // modifications) mais sans numéro serait silencieusement perdue → on le
      // signale plutôt que d'enregistrer un journal amputé.
      var incomplete = draft.some(function (e) {
        var hasContent = (e.date || "").trim() !== "" || e.changes.some(function (c) { return (c || "").trim() !== ""; });
        return hasContent && (e.version || "").trim() === "";
      });
      if (incomplete) { setStatus(status, "err", "Renseigne le numéro de version avant d'enregistrer."); return; }
      persist(true);
    });

    host.appendChild(el("div", { class: "editor__foot" }, [saveBtn, status]));
  }

  /* =======================================================================
     ONGLET PLANNER — tableau de bord façon « 365 Planner »
     Lecture publique (catégories, tickets, étiquettes, échéances, actions,
     commentaires). Édition réservée à l'admin déverrouillé, persistée en un
     seul fichier data/planner.json via le Worker (comme Liste / Changelog).
     ======================================================================= */
  var plannerDraft = null;                       // copie de travail (mode admin)
  var plannerMgr = null;                         // gestionnaire d'enregistrement (bouton)
  var dragState = null;                          // glisser-déposer d'un ticket : { fromCat, tk }
  var catDragState = null;                       // glisser-déposer d'une catégorie : la catégorie tirée
  // marque le planner « non enregistré » après une modification (bouton actif)
  function planChanged() { if (plannerMgr) plannerMgr.queue(); }
  var PLABELS = ["green", "amber", "rust", "ok", "cyan", "violet"];
  var PSTATUS = { todo: "À faire", doing: "En cours", done: "Terminé" };
  // Délai de rétention de l'archive : un ticket archivé est supprimé après deux semaines.
  var ARCHIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  function plUid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function plClone(o) { return JSON.parse(JSON.stringify(o)); }

  // Empreinte du *contenu* d'un ticket (hors id/created/modified) : sert à
  // détecter une vraie modification à la fermeture de l'éditeur pour dater le
  // champ « modified ».
  function ticketFingerprint(t) {
    return JSON.stringify({
      title: t.title, description: t.description, url: t.url, status: t.status,
      due: t.due, labels: t.labels, actions: t.actions, comments: t.comments
    });
  }

  // Construit un href sûr depuis une URL saisie par l'admin : impose le schéma
  // http(s) (préfixe https:// si absent) afin d'écarter tout javascript:/data:.
  function plUrlHref(raw) {
    var u = String(raw || "").trim();
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;             // déjà http(s)
    if (/^\/\//.test(u)) return "https:" + u;          // protocole-relatif //exemple.com
    return "https://" + u.replace(/^[a-z][\w+.\-]*:\/*/i, ""); // sinon force https (retire tout schéma exotique)
  }

  function normalizeTicket(t) {
    t = t && typeof t === "object" ? t : {};
    return {
      id: t.id || plUid("tk"),
      title: String(t.title || ""),
      description: String(t.description || ""),
      url: String(t.url || ""),
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
      modified: String(t.modified || t.created || ""),
      // Horodatage d'entrée dans l'archive (vide hors archive). Sert au compte à
      // rebours et à la purge automatique au bout de deux semaines.
      archived: String(t.archived || "")
    };
  }

  function normalizePlanner(o) {
    o = o && typeof o === "object" ? o : {};
    var cats = (Array.isArray(o.categories) ? o.categories : []).map(function (c) {
      c = c || {};
      return { id: c.id || plUid("cat"), name: String(c.name || ""), archive: !!c.archive, tickets: (Array.isArray(c.tickets) ? c.tickets : []).map(normalizeTicket) };
    });
    // Une seule catégorie d'archive ; créée (nommée « ARCHIVE ») si elle n'existe pas.
    var hasArchive = false;
    cats.forEach(function (c) { if (c.archive) { if (hasArchive) c.archive = false; else hasArchive = true; } });
    if (!hasArchive) cats.push({ id: "cat_archive", name: "ARCHIVE", archive: true, tickets: [] });
    return {
      labels: (Array.isArray(o.labels) ? o.labels : []).map(function (l) {
        l = l || {};
        return { id: l.id || plUid("lbl"), name: String(l.name || ""), color: PLABELS.indexOf(l.color) !== -1 ? l.color : "green" };
      }),
      categories: cats
    };
  }

  function isOverdue(due) {
    if (!due) return false;
    var d = new Date(due + "T23:59:59");
    return !isNaN(d.getTime()) && d.getTime() < Date.now();
  }

  /* ---- archive : catégorie spéciale à purge automatique ---- */
  function isArchiveCat(c) { return !!(c && c.archive); }
  function findArchiveCat(p) { for (var i = 0; i < p.categories.length; i++) if (p.categories[i].archive) return p.categories[i]; return null; }
  function firstOpenCat(p) { for (var i = 0; i < p.categories.length; i++) if (!p.categories[i].archive) return p.categories[i]; return null; }

  // Horodate l'entrée dans l'archive (ou efface le marqueur à la sortie), selon la
  // catégorie de destination. Le compte à rebours de deux semaines part de là.
  function stampArchiveOnMove(toCat, tk) {
    if (isArchiveCat(toCat)) { if (!tk.archived) tk.archived = new Date().toISOString(); }
    else tk.archived = "";
  }

  // Jours restants avant suppression d'un ticket archivé (peut être ≤ 0). null si non daté.
  function archiveDaysLeft(tk) {
    var ts = Date.parse(tk.archived);
    if (isNaN(ts)) return null;
    return Math.ceil((ts + ARCHIVE_TTL_MS - Date.now()) / 86400000);
  }

  // Datage et purge de l'archive : horodate les tickets archivés non datés, supprime
  // ceux archivés depuis plus de deux semaines, et efface tout marqueur résiduel hors
  // archive. Renvoie true si le modèle a changé (pour persister côté admin).
  function reconcileArchive(p) {
    var now = Date.now(), changed = false;
    p.categories.forEach(function (c) {
      if (isArchiveCat(c)) {
        c.tickets.forEach(function (t) { if (!t.archived) { t.archived = new Date(now).toISOString(); changed = true; } });
        var before = c.tickets.length;
        c.tickets = c.tickets.filter(function (t) {
          var ts = Date.parse(t.archived);
          return isNaN(ts) || (now - ts) < ARCHIVE_TTL_MS;
        });
        if (c.tickets.length !== before) changed = true;
      } else {
        c.tickets.forEach(function (t) { if (t.archived) { t.archived = ""; changed = true; } });
      }
    });
    return changed;
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
        // Purge des tickets archivés depuis plus de deux semaines : persistée si besoin.
        var purged = reconcileArchive(plannerDraft);
        renderPlannerAdmin();
        if (purged) planChanged();
      })
      .catch(function (e) { loadError(host, "Impossible de charger le planner pour édition (" + e.message + ").", renderPlanner); });
  }

  function renderPlannerReadonly() {
    var host = $("#plannerHost");
    clear(host);
    // Côté public : masque les tickets archivés expirés (la suppression réelle est
    // persistée au prochain passage d'un admin).
    reconcileArchive(data.planner);
    if (!data.planner.categories.length) {
      host.appendChild(el("p", { class: "list-empty", text: "Le planificateur est vide pour le moment." }));
      return;
    }
    host.appendChild(buildBoard(data.planner, false));
  }

  function renderPlannerAdmin() {
    var host = $("#plannerHost");
    clear(host);
    resetAutosavers();
    host.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "ADMIN" }),
      el("span", { text: "Édition du planner — modifie puis enregistre." }),
      el("button", { class: "btn btn--ghost btn--mini", text: "Gérer les étiquettes", onClick: openLabelManager })
    ]));
    host.appendChild(el("div", { id: "plannerBoardWrap" }));
    var status = el("span", { class: "editor__status" });
    // l'enregistrement ne remplace PAS plannerDraft (une modale peut être ouverte
    // sur un ticket de ce brouillon) : il met seulement à jour la version publique.
    plannerMgr = makeSaver("planner.json", buildPlannerClean, status,
      function (clean) { data.planner = normalizePlanner(clean); });
    host.appendChild(saveFoot(plannerMgr, status));
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
          paintBoard(); planChanged();
        } })
      ]));
    }
    return board;
  }

  function buildBucket(p, cat, editable) {
    var archive = isArchiveCat(cat);
    var head, grip = null;
    if (editable) {
      grip = el("span", { class: "bucket__grip", title: "Glisser pour déplacer la catégorie", text: "⠿", draggable: "true" });
      var nameInp = el("input", { class: "bucket__edit", type: "text", value: cat.name, placeholder: "Catégorie…" });
      nameInp.addEventListener("input", function () { cat.name = nameInp.value; planChanged(); });
      var headKids = [grip, nameInp, el("span", { class: "bucket__count", text: String(cat.tickets.length) })];
      if (archive) {
        // L'archive n'est pas supprimable (elle serait recréée) : on indique sa purge auto.
        headKids.push(el("span", { class: "bucket__note", title: "Les tickets archivés sont supprimés après deux semaines", text: "⏳ 2 sem." }));
      } else {
        headKids.push(el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer la catégorie", text: "✕", onClick: function () {
          if (cat.tickets.length && !window.confirm("Supprimer « " + (cat.name || "cette catégorie") + " » et ses " + cat.tickets.length + " ticket(s) ?")) return;
          var i = plannerDraft.categories.indexOf(cat);
          if (i !== -1) plannerDraft.categories.splice(i, 1);
          paintBoard(); planChanged();
        } }));
      }
      head = el("div", { class: "bucket__head" }, headKids);
    } else {
      head = el("div", { class: "bucket__head" }, [
        el("span", { class: "bucket__name", text: cat.name || "Sans nom" }),
        el("span", { class: "bucket__count", text: String(cat.tickets.length) })
      ]);
    }

    var cards = el("div", { class: "bucket__cards" });
    cat.tickets.forEach(function (tk) { cards.appendChild(buildCard(p, cat, tk, editable)); });

    var bucket = el("div", { class: "bucket" + (archive ? " bucket--archive" : "") }, [head, cards]);
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

      // glisser-déposer de la catégorie elle-même (réordonnancement horizontal)
      grip.addEventListener("dragstart", function (e) {
        catDragState = cat;
        bucket.classList.add("is-catdragging");
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", cat.id); } catch (_) {} }
      });
      grip.addEventListener("dragend", function () {
        catDragState = null;
        $all(".bucket.is-catdragging, .bucket.is-catdrop-before, .bucket.is-catdrop-after")
          .forEach(function (b) { b.classList.remove("is-catdragging", "is-catdrop-before", "is-catdrop-after"); });
      });
      bucket.addEventListener("dragover", function (e) {
        if (!catDragState || catDragState === cat) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        var box = bucket.getBoundingClientRect();
        var before = e.clientX < box.left + box.width / 2;
        bucket.classList.toggle("is-catdrop-before", before);
        bucket.classList.toggle("is-catdrop-after", !before);
      });
      bucket.addEventListener("dragleave", function (e) {
        if (!bucket.contains(e.relatedTarget)) bucket.classList.remove("is-catdrop-before", "is-catdrop-after");
      });
      bucket.addEventListener("drop", function (e) {
        if (!catDragState || catDragState === cat) return;
        e.preventDefault();
        var box = bucket.getBoundingClientRect();
        var before = e.clientX < box.left + box.width / 2;
        var moved = catDragState;
        bucket.classList.remove("is-catdrop-before", "is-catdrop-after");
        moveCategory(moved, cat, before);
      });

      bucket.appendChild(el("button", { class: "btn btn--ghost btn--mini bucket__add", text: "+ ticket", onClick: function () {
        var tk = normalizeTicket({ created: new Date().toISOString() });
        cat.tickets.push(tk);
        stampArchiveOnMove(cat, tk); // si la catégorie est l'archive, le ticket est daté
        openTicketEdit(cat, tk);
      } }));
    }
    return bucket;
  }

  // Réordonne une catégorie : la place avant ou après la catégorie cible.
  function moveCategory(fromCat, toCat, before) {
    catDragState = null;
    var cats = plannerDraft.categories;
    var fi = cats.indexOf(fromCat);
    if (fi === -1 || fromCat === toCat) return;
    cats.splice(fi, 1);
    var ti = cats.indexOf(toCat);
    if (ti === -1) cats.push(fromCat);
    else cats.splice(before ? ti : ti + 1, 0, fromCat);
    paintBoard(); planChanged();
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
    stampArchiveOnMove(toCat, tk); // (dés)archivage par glisser-déposer
    dragState = null;
    paintBoard(); planChanged();
  }

  function buildCard(p, cat, tk, editable) {
    var children = [];
    if (tk.labels.length) {
      var lab = el("div", { class: "tcard__labels" });
      p.labels.forEach(function (l) { if (tk.labels.indexOf(l.id) !== -1) lab.appendChild(el("span", { class: "plabel plabel--" + l.color, text: l.name })); });
      children.push(lab);
    }
    children.push(el("div", { class: "tcard__title", text: tk.title || "(sans titre)" }));

    // description en façade dès qu'elle est renseignée
    if (tk.description) children.push(el("div", { class: "tcard__desc", text: tk.description }));

    // URL facultative : lien cliquable sous la description (visiteurs comme admin)
    if (tk.url) {
      var urlLink = el("a", { class: "tcard__link", href: plUrlHref(tk.url), target: "_blank", rel: "noopener noreferrer", text: "↗ " + tk.url });
      // le clic sur le lien ne doit pas ouvrir/déplier le ticket
      urlLink.addEventListener("click", function (e) { e.stopPropagation(); });
      children.push(urlLink);
    }

    // liste des actions en façade (y compris celles déjà cochées)
    if (tk.actions.length) {
      var acts = el("div", { class: "tcard__acts" });
      tk.actions.forEach(function (a) {
        acts.appendChild(el("div", { class: "pcheck" + (a.done ? " is-done" : "") }, [
          el("span", { class: "pcheck__box", text: a.done ? "✓" : "" }),
          el("span", { class: "pcheck__text", text: a.text })
        ]));
      });
      children.push(acts);
    }

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
    // Compte à rebours avant purge : repère d'admin (les visiteurs voient l'archive
    // comme une catégorie normale).
    if (editable && isArchiveCat(cat)) {
      var left = archiveDaysLeft(tk);
      if (left !== null) foot.appendChild(el("span", { class: "pbadge pbadge--archive", title: "Suppression automatique après deux semaines d'archivage", text: left > 0 ? ("🗑 " + left + " j") : "🗑 bientôt" }));
    }
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
      p.labels.forEach(function (l) { if (tk.labels.indexOf(l.id) !== -1) lab.appendChild(el("span", { class: "plabel plabel--" + l.color, text: l.name })); });
      body.appendChild(lab);
    }
    if (tk.description) body.appendChild(el("p", { class: "tdesc", text: tk.description }));
    // URL facultative : lien cliquable sous la description
    if (tk.url) body.appendChild(el("a", { class: "turl", href: plUrlHref(tk.url), target: "_blank", rel: "noopener noreferrer", text: "↗ " + tk.url }));

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
    var actDragId = null;                 // glisser-déposer des actions : id en cours
    var content = el("div", { class: "modal__inner" });

    var titleInp = el("input", { class: "input modal__titleinput", type: "text", value: tk.title, placeholder: "Titre du ticket" });
    titleInp.addEventListener("input", function () { tk.title = titleInp.value; planChanged(); });
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
    status.addEventListener("change", function () { tk.status = status.value; planChanged(); });
    var due = el("input", { class: "input input--sm", type: "date", value: tk.due || "" });
    due.addEventListener("input", function () { tk.due = due.value; planChanged(); });
    body.appendChild(el("div", { class: "frow" }, [
      el("label", { class: "field field--inline" }, [el("span", { class: "field__label", text: "État" }), status]),
      el("label", { class: "field field--inline" }, [el("span", { class: "field__label", text: "Date de réalisation" }), due])
    ]));

    var desc = el("textarea", { class: "textarea", rows: "3", placeholder: "Description…" });
    desc.value = tk.description;
    desc.addEventListener("input", function () { tk.description = desc.value; planChanged(); });
    body.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Description" }), desc]));

    // URL facultative : champ modifiable + lien « Ouvrir » qui suit la saisie
    var urlInp = el("input", { class: "input input--sm", type: "url", value: tk.url || "", placeholder: "https://exemple.com (facultatif)" });
    var urlOpen = el("a", { class: "field__open", target: "_blank", rel: "noopener noreferrer", text: "Ouvrir ↗" });
    function syncUrlOpen() {
      var href = plUrlHref(urlInp.value);
      if (href) { urlOpen.href = href; urlOpen.hidden = false; }
      else { urlOpen.removeAttribute("href"); urlOpen.hidden = true; }
    }
    urlInp.addEventListener("input", function () { tk.url = urlInp.value; syncUrlOpen(); planChanged(); });
    syncUrlOpen();
    body.appendChild(el("label", { class: "field" }, [
      el("span", { class: "field__label field__label--row" }, [el("span", { text: "URL (facultatif)" }), urlOpen]),
      urlInp
    ]));

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
    var cText = el("input", { class: "input", type: "text", placeholder: "Ajouter un commentaire (Entrée pour valider)…" });
    body.appendChild(el("div", { class: "commentadd" }, [authorPick.node, cText]));

    // Déplace le ticket vers une autre catégorie (datage d'archive géré), puis ferme.
    function relocateTicket(dest) {
      if (!dest || dest === cat) { closeModal(); return; }
      var i = cat.tickets.indexOf(tk);
      if (i !== -1) cat.tickets.splice(i, 1);
      dest.tickets.push(tk);
      stampArchiveOnMove(dest, tk);
      planChanged();
      closeModal();
    }

    var footKids = [
      el("button", { class: "btn btn--ghost btn--danger", text: "Supprimer le ticket", onClick: function () {
        if (!window.confirm("Supprimer ce ticket ?")) return;
        var i = cat.tickets.indexOf(tk);
        if (i !== -1) cat.tickets.splice(i, 1);
        planChanged();
        closeModal();
      } })
    ];
    // Bouton d'archivage (admin) : déplace le ticket vers / hors de l'archive.
    var archiveCat = findArchiveCat(p);
    if (isArchiveCat(cat)) {
      footKids.push(el("button", { class: "btn btn--ghost", text: "Désarchiver", title: "Retirer ce ticket de l'archive", onClick: function () { relocateTicket(firstOpenCat(p)); } }));
    } else if (archiveCat) {
      footKids.push(el("button", { class: "btn btn--ghost", text: "Archiver", title: "Déplacer ce ticket vers l'archive (suppression auto après 2 semaines)", onClick: function () { relocateTicket(archiveCat); } }));
    }
    footKids.push(el("span", { class: "muted-note", text: "À enregistrer depuis le planner." }));
    footKids.push(el("button", { class: "btn btn--ghost", text: "Fermer", onClick: closeModal }));
    content.appendChild(el("div", { class: "modal__foot" }, footKids));

    function paintLabels() {
      clear(labWrap);
      if (!p.labels.length) { labWrap.appendChild(el("span", { class: "muted-note", text: "Aucune étiquette (voir « Gérer les étiquettes »)." })); return; }
      p.labels.forEach(function (l) {
        var on = tk.labels.indexOf(l.id) !== -1;
        var chip = el("button", { class: "plabel plabel--" + l.color + (on ? " is-on" : " is-off"), text: l.name || "?" });
        chip.addEventListener("click", function () {
          var i = tk.labels.indexOf(l.id);
          if (i === -1) tk.labels.push(l.id); else tk.labels.splice(i, 1);
          paintLabels(); planChanged();
        });
        labWrap.appendChild(chip);
      });
    }
    function paintActions(focusLast) {
      clear(actBox);
      tk.actions.forEach(function (a, i) {
        var grip = el("span", { class: "pcheck__grip", title: "Glisser pour réordonner", text: "⠿", draggable: "true" });
        var toggle = el("button", { class: "pcheck__toggle" + (a.done ? " is-done" : ""), text: a.done ? "✓" : "", title: a.done ? "Décocher" : "Cocher" });
        toggle.addEventListener("click", function () { a.done = !a.done; paintActions(); planChanged(); });
        var txt = el("input", { class: "input input--bare", type: "text", value: a.text, placeholder: "Action…" });
        txt.addEventListener("input", function () { a.text = txt.value; planChanged(); });
        var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕", onClick: function () { tk.actions.splice(i, 1); paintActions(); planChanged(); } });
        var row = el("div", { class: "pcheck pcheck--edit" + (a.done ? " is-done" : ""), "data-acid": a.id }, [grip, toggle, txt, del]);
        // cliquer sur la ligne (hors case/poignée/supprimer) place le curseur dans le champ
        row.addEventListener("click", function (e) {
          if (e.target === txt || e.target === grip || e.target === toggle || toggle.contains(e.target) || e.target === del || del.contains(e.target)) return;
          txt.focus();
        });
        // glisser-déposer pour réordonner les actions (via la poignée)
        grip.addEventListener("dragstart", function (e) {
          actDragId = a.id; row.classList.add("is-dragging");
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", a.id); } catch (_) {} }
        });
        grip.addEventListener("dragend", function () { actDragId = null; row.classList.remove("is-dragging"); });
        row.addEventListener("dragover", function (e) {
          if (actDragId == null || actDragId === a.id) return;
          e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        });
        row.addEventListener("drop", function (e) {
          if (actDragId == null || actDragId === a.id) return;
          e.preventDefault();
          var from = -1;
          for (var k = 0; k < tk.actions.length; k++) { if (tk.actions[k].id === actDragId) { from = k; break; } }
          if (from === -1) return;
          var box = row.getBoundingClientRect();
          var after = e.clientY > box.top + box.height / 2;
          var moved = tk.actions.splice(from, 1)[0];
          var to = 0;
          for (var m = 0; m < tk.actions.length; m++) { if (tk.actions[m].id === a.id) { to = m; break; } }
          tk.actions.splice(after ? to + 1 : to, 0, moved);
          actDragId = null;
          paintActions(); planChanged();
        });
        actBox.appendChild(row);
      });
      // ligne fantôme : taper dedans crée une action (les actions vides ne comptent pas)
      var ghost = el("input", { class: "input input--bare input--ghost", type: "text", value: "", placeholder: "Ajouter une action…" });
      ghost.addEventListener("input", function () {
        if (ghost.value === "") return;
        tk.actions.push({ id: plUid("ac"), text: ghost.value, done: false });
        paintActions(true); planChanged();
      });
      actBox.appendChild(el("div", { class: "pcheck pcheck--edit pcheck--ghost" }, [
        el("span", { class: "pcheck__grip pcheck__grip--ghost", "aria-hidden": "true" }),
        el("span", { class: "pcheck__toggle pcheck__toggle--ghost", "aria-hidden": "true" }), ghost
      ]));
      if (focusLast) {
        var inputs = actBox.querySelectorAll(".pcheck input");
        var t = inputs[tk.actions.length - 1];
        if (t) { t.focus(); var L = t.value.length; try { t.setSelectionRange(L, L); } catch (_) {} }
      }
    }
    function paintComments() {
      clear(comBox);
      tk.comments.forEach(function (c, i) {
        comBox.appendChild(el("div", { class: "pcomment" }, [
          el("div", { class: "pcomment__meta" }, [
            el("span", { text: (c.author || "Admin") + " · " + fmtDate(c.date) }),
            el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕", onClick: function () { tk.comments.splice(i, 1); paintComments(); planChanged(); } })
          ]),
          el("div", { class: "pcomment__text", text: c.text })
        ]));
      });
      if (!tk.comments.length) comBox.appendChild(el("p", { class: "list-empty", text: "Aucun commentaire." }));
    }
    function addComment() {
      var t = cText.value.trim(); if (!t) return;
      tk.comments.push({ id: plUid("cm"), author: authorPick.value(), date: new Date().toISOString(), text: t });
      cText.value = ""; paintComments(); planChanged();
    }
    cText.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addComment(); } });

    paintLabels(); paintActions(); paintComments();
    openModal(content, function () {
      if ((tk.title || "").trim() === "") {
        // ticket sans titre : non conservé (ni compté, ni enregistré) — on le retire
        var i = cat.tickets.indexOf(tk);
        if (i !== -1) { cat.tickets.splice(i, 1); planChanged(); }
      } else if (ticketFingerprint(tk) !== snapshot) {
        // marque la date de dernière modification si le contenu a réellement changé
        tk.modified = new Date().toISOString(); planChanged();
      }
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
    var labDragId = null;                 // glisser-déposer des étiquettes : id en cours

    function paint() {
      clear(listBox);
      p.labels.forEach(function (l, i) {
        var grip = el("span", { class: "pcheck__grip", title: "Glisser pour réordonner", text: "⠿", draggable: "true" });
        var name = el("input", { class: "input input--sm", type: "text", value: l.name, placeholder: "Nom de l'étiquette" });
        name.addEventListener("input", function () { l.name = name.value; planChanged(); });
        var colors = el("div", { class: "colorpick" });
        PLABELS.forEach(function (col) {
          var sw = el("button", { class: "swatch plabel--" + col + (l.color === col ? " is-on" : ""), title: col, "aria-label": col });
          sw.addEventListener("click", function () { l.color = col; paint(); planChanged(); });
          colors.appendChild(sw);
        });
        var del = el("button", { class: "btn btn--ghost btn--icon", title: "Supprimer", text: "✕", onClick: function () {
          p.categories.forEach(function (c) { c.tickets.forEach(function (t) { var k = t.labels.indexOf(l.id); if (k !== -1) t.labels.splice(k, 1); }); });
          p.labels.splice(i, 1); paint(); planChanged();
        } });
        var row = el("div", { class: "labelrow", "data-lblid": l.id }, [grip, name, colors, del]);
        // glisser-déposer pour réordonner les étiquettes (via la poignée) — pilote l'ordre d'affichage sur les tickets
        grip.addEventListener("dragstart", function (e) {
          labDragId = l.id; row.classList.add("is-dragging");
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", l.id); } catch (_) {} }
        });
        grip.addEventListener("dragend", function () { labDragId = null; row.classList.remove("is-dragging"); });
        row.addEventListener("dragover", function (e) {
          if (labDragId == null || labDragId === l.id) return;
          e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        });
        row.addEventListener("drop", function (e) {
          if (labDragId == null || labDragId === l.id) return;
          e.preventDefault();
          var from = -1;
          for (var k = 0; k < p.labels.length; k++) { if (p.labels[k].id === labDragId) { from = k; break; } }
          if (from === -1) return;
          var box = row.getBoundingClientRect();
          var after = e.clientY > box.top + box.height / 2;
          var moved = p.labels.splice(from, 1)[0];
          var to = 0;
          for (var m = 0; m < p.labels.length; m++) { if (p.labels[m].id === l.id) { to = m; break; } }
          p.labels.splice(after ? to + 1 : to, 0, moved);
          labDragId = null;
          paint(); planChanged();
        });
        listBox.appendChild(row);
      });
      if (!p.labels.length) listBox.appendChild(el("p", { class: "list-empty", text: "Aucune étiquette." }));
    }
    paint();

    body.appendChild(el("button", { class: "btn btn--ghost btn--mini", text: "+ étiquette", onClick: function () {
      p.labels.push({ id: plUid("lbl"), name: "", color: PLABELS[p.labels.length % PLABELS.length] }); paint();
    } }));

    content.appendChild(el("div", { class: "modal__foot" }, [
      el("span", { class: "muted-note", text: "À enregistrer depuis le planner." }),
      el("button", { class: "btn btn--ghost", text: "Fermer", onClick: closeModal })
    ]));
    openModal(content, paintBoard);
  }

  // Normalise plannerDraft en objet propre prêt à écrire (sert à l'autosave) :
  // étiquettes/tickets/actions vides écartés, horodatages préservés.
  function buildPlannerClean() {
    var d = plannerDraft;
    if (!d) return null;
    var labels = d.labels.filter(function (l) { return (l.name || "").trim() !== ""; })
      .map(function (l) { return { id: l.id, name: l.name.trim(), color: l.color }; });
    var kept = {};
    labels.forEach(function (l) { kept[l.id] = true; });
    return {
      generated: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
      labels: labels,
      categories: d.categories.map(function (c) {
        var out = { id: c.id, name: (c.name || "").trim() };
        if (c.archive) out.archive = true;
        out.tickets = c.tickets.filter(function (t) { return (t.title || "").trim() !== ""; }).map(function (t) {
          var tk = {
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
          if (isArchiveCat(c) && t.archived) tk.archived = t.archived;
          var u = (t.url || "").trim();
          if (u) tk.url = u;                 // URL facultative : écrite seulement si renseignée
          return tk;
        });
        return out;
      })
    };
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
    // verrouillage = on jette les modifications non enregistrées (aucun envoi
    // automatique au Worker, y compris sur expiration d'inactivité)
    resetAutosavers();
    leavePresence();            // signale le départ tant que le mot de passe est en mémoire
    admin.unlocked = false; admin.pwd = ""; adminDirty = false;
    stopIdleWatch();
    setPresenceBadge(0, false); // déconnecté : on masque le compteur (le public ne le voit pas)
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
      el("span", { text: "Accès réservé aux administrateurs du Pack" })
    ]));

    if (!workerReady()) { host.appendChild(renderAdminNoWorker()); return; }
    if (isAdmin()) { host.appendChild(renderAdminUnlocked()); loadMessages(); }
    else host.appendChild(renderAdminLock());
  }

  // Carte « Statistiques de téléchargement » : compteur jour / mois / total des
  // archives générées + mini-tendance sur 7 jours. Chargement asynchrone, avec
  // dégradation propre si le compteur est injoignable (bloqueur de pub, réseau).
  function renderDownloadStats() {
    var card = el("div", { class: "card" });
    card.appendChild(el("p", { class: "admin-note", text:
      "Nombre d'archives d'installation générées par les visiteurs. Comptage anonyme via un compteur public gratuit, indépendant du Worker (aucun cookie, aucune donnée personnelle)." }));

    var body = el("div", { class: "dlstats" }, [el("span", { class: "loading", text: "Lecture du compteur…" })]);
    var status = el("span", { class: "editor__status" });
    var refresh = el("button", { class: "btn btn--ghost btn--mini", text: "↻ Rafraîchir" });

    function statCell(label, n) {
      return el("div", { class: "dlstats__cell" }, [
        el("span", { class: "dlstats__num", text: formatInt(n) }),
        el("span", { class: "dlstats__lbl", text: label })
      ]);
    }
    function paint(d) {
      clear(body);
      if (d.stale) {
        body.appendChild(el("p", { class: "dlstats__stale", text:
          "⚠ Compteur en direct injoignable (Abacus). Affichage du dernier instantané enregistré"
          + (d.updated ? " le " + formatSnapDate(d.updated) : "") + " — les chiffres du jour peuvent manquer." }));
      }
      body.appendChild(el("div", { class: "dlstats__grid" }, [
        statCell("Aujourd'hui", d.today),
        statCell("Ce mois-ci", d.month),
        statCell("Total", d.total)
      ]));
      var max = 1;
      d.history.forEach(function (h) { if (h.n > max) max = h.n; });
      body.appendChild(el("div", { class: "dlstats__hist" }, d.history.map(function (h) {
        return el("div", { class: "dlstats__col", title: h.key + " — " + formatInt(h.n) + " téléchargement(s)" }, [
          el("span", { class: "dlstats__count", text: formatInt(h.n) }),
          el("span", { class: "dlstats__bar" }, [
            el("span", { class: "dlstats__fill", style: "height:" + Math.round((h.n / max) * 100) + "%" })
          ]),
          el("span", { class: "dlstats__day", text: h.label })
        ]);
      })));
      body.appendChild(el("p", { class: "dlstats__cap", text: "7 derniers jours · fuseau de Paris" }));
    }
    function paintError() {
      clear(body);
      body.appendChild(el("p", { class: "admin-note", style: "margin:0", text:
        "Compteur injoignable. Un bloqueur de pub très strict peut filtrer la requête : réessaie en le désactivant sur ce site, ou vérifie ta connexion." }));
    }
    function load() {
      refresh.disabled = true;
      setStatus(status, "work", "Lecture…");
      loadDownloadStats()
        .then(function (d) {
          paint(d);
          setStatus(status, d.stale ? "err" : "ok", d.stale ? "Abacus injoignable — instantané" : "À jour");
        })
        .catch(function () { paintError(); setStatus(status, "err", "Indisponible"); })
        .then(function () { refresh.disabled = false; });
    }
    refresh.addEventListener("click", load);

    card.appendChild(body);
    card.appendChild(el("div", { class: "editor__foot" }, [refresh, status]));
    load();
    return card;
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
    resetAutosavers();
    var wrap = el("div", {});

    wrap.appendChild(el("div", { class: "admin-bar" }, [
      el("span", { class: "admin-bar__tag", text: "CONNECTÉ" }),
      el("span", { text: "Chaque éditeur s'enregistre avec son bouton « Enregistrer ». Tu peux aussi modifier le Panneau d'affichage et le Changelog dans leurs onglets." }),
      el("button", { class: "btn btn--ghost btn--mini", text: "Verrouiller", onClick: lockAdmin })
    ]));

    // Sous-onglets de l'admin : chaque section ci-dessous est rangée dans l'un
    // des quatre panneaux (Tableau de bord / Configuration / Outils / Messages).
    // Tout est construit d'emblée — les chargements asynchrones et les autosaveurs
    // s'arment exactement comme avant ; les sous-onglets ne font que montrer ou
    // masquer le panneau actif. « target » désigne le panneau en cours de remplissage.
    var pDash   = el("div", {});  // Tableau de bord
    var pConfig = el("div", {});  // Configuration
    var pTools  = el("div", {});  // Outils
    var pMsg    = el("div", {});  // Messages
    var target = pDash;

    // ---- statistiques de téléchargement (compteur jour / mois / total) ----
    target.appendChild(el("div", { class: "stencil stencil--muted", text: "Statistiques de téléchargement" }));
    target.appendChild(renderDownloadStats());

    // ---- interrupteur du configurateur (maintenance) ----
    // Bouton ON/OFF purement mécanique : un admin coupe le configurateur (et donc
    // tout téléchargement) si le process a un problème ou pendant le développement.
    // L'état est stocké dans config.json (configurator_enabled) et lu par tous les
    // visiteurs au chargement du site.
    target.appendChild(el("div", { class: "stencil stencil--muted", text: "Configurateur (téléchargements)" }));
    var swCard = el("div", { class: "card" });
    swCard.appendChild(el("p", { class: "admin-note", text:
      "Active ou désactive le configurateur d'installation. Une fois désactivé, l'onglet Files affiche « MAINTENANCE : Configurateur désactivé » et plus aucun téléchargement n'est possible — à utiliser si le process a un problème ou pendant le développement." }));

    var swStatus = el("span", { class: "editor__status" });
    var swState = el("span", { class: "switch__state" });
    var swBtn = el("button", {
      class: "switch", type: "button", role: "switch",
      "aria-label": "Activer ou désactiver le configurateur"
    }, [el("span", { class: "switch__track" }, [el("span", { class: "switch__thumb" })])]);

    function paintSwitch() {
      var on = configuratorEnabled();
      swBtn.classList.toggle("is-on", on);
      swBtn.setAttribute("aria-checked", on ? "true" : "false");
      swState.textContent = on ? "ON · configurateur actif" : "OFF · maintenance";
      swState.className = "switch__state " + (on ? "switch__state--on" : "switch__state--off");
    }

    function toggleConfigurator() {
      if (swBtn.disabled) return;
      var next = !configuratorEnabled();
      swBtn.disabled = true;
      setStatus(swStatus, "work", "Enregistrement…");
      // Recharge la version actuelle du dépôt pour ne modifier QUE le drapeau,
      // sans embarquer d'éventuelles saisies non enregistrées des autres champs.
      loadForEdit("config.json")
        .then(function (r) {
          var obj = (r.obj && typeof r.obj === "object" && !Array.isArray(r.obj)) ? r.obj : {};
          obj.configurator_enabled = next;
          saveData("config.json", obj, swStatus, swBtn, function () {
            config.configurator_enabled = next;
            paintSwitch();
            // rafraîchit l'onglet Files s'il a déjà été rendu dans cette session
            if (loaded.files && manifest) renderConfigurator();
          });
        })
        .catch(function (e) {
          setStatus(swStatus, "err", "Échec : " + (e && e.message ? e.message : "Worker injoignable."));
          swBtn.disabled = false;
        });
    }
    swBtn.addEventListener("click", toggleConfigurator);
    paintSwitch();

    swCard.appendChild(el("div", { class: "switchrow" }, [swBtn, swState]));
    swCard.appendChild(el("div", { class: "editor__foot" }, [swStatus]));
    target.appendChild(swCard);

    // ---- configuration du site ----
    target = pConfig;
    target.appendChild(el("div", { class: "stencil stencil--muted", text: "Configuration du site" }));
    var cfgCard = el("div", { class: "card" });
    var fields = [
      { key: "site_title", label: "Titre du site" },
      { key: "site_tagline", label: "Sous-titre" },
      { key: "worker_url", label: "URL du Worker" },
      { key: "patch_base", label: "Dossier des patchs" },
      { key: "fra_path", label: "Chemin d'installation (fra)" },
      { key: "mod_zip_name", label: "Nom de l'archive (.zip)" },
      { key: "mod_author", label: "Nom des auteurs" }
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var inp = el("input", { class: "input", type: "text", value: config[f.key] != null ? config[f.key] : "" });
      inputs[f.key] = inp;
      cfgCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: f.label }), inp]));
    });
    // capte le SHA pour le verrouillage et rafraîchit depuis la version du dépôt
    loadForEdit("config.json").then(function (r) {
      if (r.obj && typeof r.obj === "object") {
        fields.forEach(function (f) { if (r.obj[f.key] != null) inputs[f.key].value = r.obj[f.key]; });
        // synchronise l'interrupteur sur l'état réel du dépôt (source autoritaire)
        if (typeof r.obj.configurator_enabled === "boolean") { config.configurator_enabled = r.obj.configurator_enabled; paintSwitch(); }
      }
    }).catch(function () {});
    var cfgStatus = el("span", { class: "editor__status" });
    function buildCfg() {
      var obj = {};
      fields.forEach(function (f) { obj[f.key] = inputs[f.key].value.trim(); });
      // L'état du configurateur est piloté par son interrupteur dédié : on le
      // préserve pour ne pas l'écraser en enregistrant la configuration du site.
      obj.configurator_enabled = configuratorEnabled();
      return obj;
    }
    function applyCfg(obj) {
      config = Object.assign(config, obj);
      if (config.site_title) { document.title = config.site_title; $("#brandTitle").textContent = config.site_title; }
      if (config.site_tagline) $("#brandTag").textContent = config.site_tagline;
    }
    // Enregistrement manuel : un bouton + une confirmation avant d'écrire.
    var cfgBtn = el("button", { class: "btn btn--green", text: "Enregistrer" });
    cfgBtn.addEventListener("click", function () {
      showConfirm({
        title: "Modifier la configuration",
        message: "Es-tu sûr de vouloir modifier la configuration du site ?",
        confirmText: "Enregistrer"
      }, function () {
        var obj = buildCfg();
        saveData("config.json", obj, cfgStatus, cfgBtn, function () { applyCfg(obj); });
      });
    });
    cfgCard.appendChild(el("div", { class: "editor__foot" }, [cfgBtn, cfgStatus]));
    target.appendChild(cfgCard);

    // ---- administrateurs (pseudos du sélecteur d'auteur des commentaires planner) ----
    target.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Administrateurs" }));
    var admCard = el("div", { class: "card" });
    admCard.appendChild(el("p", { class: "admin-note", text:
      "Pseudos proposés dans la liste déroulante « Auteur » lors de l'ajout d'un commentaire dans le Planner." }));
    var admRows = el("div", { class: "editrows" });
    admCard.appendChild(admRows);
    var admDraft = [];
    var admStatus = el("span", { class: "editor__status" });
    var admMgr = makeSaver("admins.json", function () {
      return admDraft.map(function (s) { return (s || "").trim(); }).filter(function (s) { return s !== ""; });
    }, admStatus, function (clean) { data.admins = clean; });
    function drawAdmRows() {
      renderGhostInputs(admRows, admDraft, {
        placeholder: "Pseudo",
        ghostPlaceholder: "Ajouter un pseudo…",
        onChange: function () { data.admins = admDraft.map(function (s) { return (s || "").trim(); }).filter(Boolean); admMgr.queue(); }
      });
    }
    admCard.appendChild(saveFoot(admMgr, admStatus));
    target.appendChild(admCard);
    loadForEdit("admins.json")
      .then(function (r) { admDraft = Array.isArray(r.obj) ? r.obj.slice() : []; data.admins = admDraft.slice(); drawAdmRows(); })
      .catch(function () { drawAdmRows(); });

    // ---- générateur de patch.json (téléchargement local, sans Worker) ----
    target = pTools;
    target.appendChild(el("div", { class: "stencil stencil--muted", text: "Générateur de patch.json" }));
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
    target.appendChild(pgCard);

    // ---- texte du lisez-moi (onglet Files) ----
    target = pConfig;
    target.appendChild(el("div", { class: "stencil stencil--muted", style: "margin-top:24px", text: "Texte du lisez-moi (onglet Files)" }));
    var rmCard = el("div", { class: "card" });
    var rm = el("textarea", { class: "textarea", rows: "8", placeholder: "Texte affiché en haut de l'onglet Files\u2026" });
    rm.value = "Chargement\u2026"; rm.disabled = true;
    loadForEdit("files.json")
      .then(function (r) { rm.value = (r.obj && r.obj.readme) || ""; rm.disabled = false; })
      .catch(function () { rm.value = ""; rm.disabled = false; });
    var rmStatus = el("span", { class: "editor__status" });
    var rmMgr = makeSaver("files.json", function () {
      if (rm.disabled) return null; // pas encore chargé : ne rien écrire
      return { readme: rm.value };
    }, rmStatus);
    rm.addEventListener("input", rmMgr.queue);
    rmCard.appendChild(el("label", { class: "field" }, [el("span", { class: "field__label", text: "Contenu" }), rm]));
    rmCard.appendChild(saveFoot(rmMgr, rmStatus));
    target.appendChild(rmCard);

    // ---- messages reçus (contact) ----
    target = pMsg;
    target.appendChild(el("div", { class: "stencil stencil--muted", text: "Messages reçus" }));
    var inboxCard = el("div", { class: "card" });
    inboxCard.appendChild(el("div", { class: "inbox__head" }, [
      el("span", { class: "inbox__title", text: "Boîte de réception" }),
      el("button", { class: "btn btn--ghost btn--mini", text: "Rafraîchir", onClick: loadMessages })
    ]));
    inboxCard.appendChild(el("div", { id: "adminInbox" }, [el("span", { class: "loading", text: "Chargement\u2026" })]));
    target.appendChild(inboxCard);

    // barre de sous-onglets + panneaux, insérés sous la barre admin
    var sub = buildAdminSubtabs([
      { id: "dash",   label: "Tableau de bord", panel: pDash },
      { id: "config", label: "Configuration",   panel: pConfig },
      { id: "tools",  label: "Outils",          panel: pTools },
      { id: "msg",    label: "Messages",        panel: pMsg }
    ]);
    wrap.appendChild(sub.nav);
    wrap.appendChild(sub.host);

    return wrap;
  }

  // ---- enregistrement générique vers le Worker ---------------------------
  function saveData(filename, obj, status, btn, onSuccess, onDone) {
    if (!isAdmin()) { setStatus(status, "err", "Session admin verrouillée."); if (onDone) onDone(); return; }
    if (!config.worker_url || config.worker_url.indexOf("VOTRE-SOUS-DOMAINE") !== -1) {
      setStatus(status, "err", "worker_url non configuré dans data/config.json."); if (onDone) onDone(); return;
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
          leavePresence(); admin.unlocked = false; admin.pwd = ""; adminDirty = false; stopIdleWatch(); setPresenceBadge(0, false);
        } else if (res.status === 429) {
          setStatus(status, "err", "Trop de tentatives. Réessaie dans quelques minutes.");
        } else {
          setStatus(status, "err", (res.data && res.data.error) || ("Échec (HTTP " + res.status + ")"));
        }
      })
      .catch(function () { setStatus(status, "err", "Worker injoignable. Vérifie l'URL et le déploiement."); })
      .then(function () { if (btn) btn.disabled = false; if (typeof onDone === "function") onDone(); });
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

  /* =======================================================================
     ONGLET UPDATES — vérification automatique des mises à jour ModDB
     ======================================================================= */
  var updatesData = null;   // cache de mod_updates.json
  var TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

  function loadUpdates() {
    var host = $("#updatesHost");
    fetchJSON("data/mod_updates.json", { cache: "no-store" })
      .then(function (o) { updatesData = o; renderUpdates(); })
      .catch(function (e) { loadError(host, "Impossible de charger les mises à jour (" + e.message + ").", loadUpdates); });
  }

  function renderUpdates() {
    var host = $("#updatesHost");
    host.innerHTML = "";

    // Barre d'outils admin : déclenchement manuel d'un scan ModDB.
    if (isAdmin()) host.appendChild(buildScanToolbar());

    var allUpdates = (updatesData && Array.isArray(updatesData.updates)) ? updatesData.updates : [];
    var now = Date.now();

    // Filtrer : on affiche seulement ceux avec has_update=true et non ackés (ou ackés depuis moins de 2 semaines)
    var visible = allUpdates.filter(function (u) {
      if (!u.has_update) return false;
      if (u.acknowledged_at) {
        var ackTime = new Date(u.acknowledged_at).getTime();
        if (!isNaN(ackTime) && (now - ackTime) > TWO_WEEKS_MS) return false;
      }
      return true;
    });

    if (visible.length === 0) {
      var empty = el("p", { class: "updates__empty", text: "Aucune mise à jour détectée pour le moment." });
      host.appendChild(empty);
    } else {
      visible.forEach(function (u) {
        host.appendChild(buildUpdateCard(u));
      });
    }

    if (updatesData && updatesData.generated) {
      var footer = el("p", { class: "updates__footer" });
      footer.textContent = "Dernière vérification : " + fmtDate(updatesData.generated);
      host.appendChild(footer);
    }
  }

  // Barre d'outils admin de l'onglet Updates : bouton de scan manuel + statut.
  function buildScanToolbar() {
    var bar = el("div", { class: "updates__toolbar" });
    var statusEl = el("span", { class: "editor__status" });
    var btn = el("button", {
      class: "btn updates__scan-btn",
      text: "Lancer un scan",
      title: "Vérifie maintenant les versions des mods sur ModDB"
    });
    btn.addEventListener("click", function () { triggerUpdateScan(statusEl, btn); });
    bar.appendChild(btn);
    bar.appendChild(statusEl);
    return bar;
  }

  // Déclenche le workflow GitHub de vérification ModDB via le Worker (/scan-updates).
  // Le scan tourne côté GitHub Actions : le résultat (mod_updates.json) n'est
  // disponible qu'après quelques minutes, d'où le message invitant à recharger.
  function triggerUpdateScan(status, btn) {
    if (!isAdmin()) { setStatus(status, "err", "Session admin verrouillée."); return; }
    if (!config.worker_url || config.worker_url.indexOf("VOTRE-SOUS-DOMAINE") !== -1) {
      setStatus(status, "err", "worker_url non configuré dans data/config.json."); return;
    }
    btn.disabled = true;
    setStatus(status, "work", "Lancement du scan…");

    var ok = false;
    fetch(config.worker_url.replace(/\/$/, "") + "/scan-updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: admin.pwd })
    })
      .then(function (r) {
        return r.json().catch(function () { return { error: "Réponse illisible (HTTP " + r.status + ")" }; })
          .then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
      })
      .then(function (res) {
        if (res.ok && res.data && res.data.success) {
          ok = true;
          setStatus(status, "ok", "Scan lancé. Les résultats apparaîtront dans quelques minutes — recharge la page pour les voir.");
        } else if (res.status === 401) {
          setStatus(status, "err", "Session expirée. Reconnecte-toi dans l'onglet Admin.");
        } else if (res.status === 429) {
          setStatus(status, "err", "Trop de tentatives. Réessaie dans quelques minutes.");
        } else {
          setStatus(status, "err", (res.data && res.data.error) || ("Échec (HTTP " + res.status + ")"));
        }
      })
      .catch(function () { setStatus(status, "err", "Worker injoignable. Vérifie l'URL et le déploiement."); })
      .then(function () {
        if (!btn) return;
        // Anti-spam : on laisse le workflow démarrer avant de réautoriser un scan.
        if (ok) setTimeout(function () { btn.disabled = false; }, 10000);
        else btn.disabled = false;
      });
  }

  function buildUpdateCard(u) {
    var card = el("div", { class: "card update-card" + (u.acknowledged_at ? " update-card--acked" : "") });

    var header = el("div", { class: "update-card__header" });
    var title = el("strong", { text: u.name });
    header.appendChild(title);

    var badge = el("span", { class: "update-badge" });
    badge.textContent = (u.version_local || "?") + " → " + (u.version_remote || "?");
    header.appendChild(badge);
    card.appendChild(header);

    var link = el("a", { class: "update-card__link" });
    link.href = u.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Voir sur ModDB";
    card.appendChild(link);

    if (u.acknowledged_at) {
      var ackNote = el("p", { class: "update-card__acked", text: "Pris en compte le " + fmtDate(u.acknowledged_at) });
      card.appendChild(ackNote);
    } else if (isAdmin()) {
      var statusEl = el("span", { class: "editor__status" });
      var btn = el("button", { class: "btn update-card__ack-btn", text: "Pris en compte" });
      btn.addEventListener("click", function () {
        btn.disabled = true;
        acknowledgeUpdate(u, statusEl, btn);
      });
      card.appendChild(btn);
      card.appendChild(statusEl);
    }

    return card;
  }

  function acknowledgeUpdate(u, statusEl, btn) {
    // 1. Créer un ticket dans le planner (catégorie "prochainement" = cat_done)
    if (data.planner) {
      var plannerObj = plClone(data.planner);
      var targetCat = null;
      for (var i = 0; i < plannerObj.categories.length; i++) {
        if (plannerObj.categories[i].id === "cat_done") { targetCat = plannerObj.categories[i]; break; }
      }
      if (!targetCat && plannerObj.categories.length > 0) targetCat = plannerObj.categories[0];
      if (targetCat) {
        var ticket = {
          id: plUid("tk"),
          title: u.name,
          description: "Update disponible : v" + (u.version_local || "?") + " → v" + (u.version_remote || "?"),
          status: "todo",
          due: null,
          labels: ["lbl_mqiajiyf4urc"],
          actions: [],
          comments: [],
          created: new Date().toISOString(),
          modified: new Date().toISOString()
        };
        targetCat.tickets.push(ticket);
        data.planner = normalizePlanner(plannerObj);
        saveData("planner.json", buildPlannerClean(), statusEl, null, null, null);
      }
    }

    // 2. Mettre à jour acknowledged_at dans mod_updates.json
    var ackTime = new Date().toISOString();
    for (var j = 0; j < updatesData.updates.length; j++) {
      if (updatesData.updates[j].id === u.id) {
        updatesData.updates[j].acknowledged_at = ackTime;
        break;
      }
    }
    saveData("mod_updates.json", updatesData, statusEl, btn, function () {
      renderUpdates();
    }, null);
  }

})();

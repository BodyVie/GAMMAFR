/* =========================================================================
   GAMMA · Traduction FR — logique applicative (vanilla JS, zéro dépendance)
   Aucun stockage local : le mot de passe admin ne vit qu'en mémoire et part
   avec chaque requête vers le Cloudflare Worker.
   ========================================================================= */
(function () {
  "use strict";

  // ---- état --------------------------------------------------------------
  var config = { worker_url: "", formspree_id: "", site_title: "GAMMAFR", site_tagline: "" };
  var loaded = { files: false, liste: false, changelog: false, admin: false };

  var wizard = {
    steps: [],
    stepIndex: 0,
    selections: {}, // { stepId: { optionId: true } }
    optionsById: {} // { optionId: optionObject } pour retrouver les liens
  };

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
    if (name === "liste" && !loaded.liste) loadListe();
    if (name === "changelog" && !loaded.changelog) loadChangelog();
    if (name === "admin" && !loaded.admin) loadAdmin();
  }

  /* =======================================================================
     ONGLET FILES — lisez-moi + wizard FOMOD
     ======================================================================= */
  function loadFiles() {
    loaded.files = true;
    var briefing = $("#briefing");
    var host = $("#wizard");
    fetchJSON("data/files.json")
      .then(function (data) {
        briefing.textContent = data.readme || "";
        wizard.steps = Array.isArray(data.steps) ? data.steps : [];
        wizard.stepIndex = 0;
        wizard.selections = {};
        wizard.optionsById = {};
        wizard.steps.forEach(function (step) {
          wizard.selections[step.id] = {};
          (step.options || []).forEach(function (opt) { wizard.optionsById[opt.id] = opt; });
        });
        renderWizard();
      })
      .catch(function (e) {
        briefing.textContent = "";
        host.innerHTML = "";
        host.appendChild(el("p", { class: "list-empty", text: "Impossible de charger le configurateur (" + e.message + ")." }));
      });
  }

  function renderWizard() {
    var host = $("#wizard");
    clear(host);

    var total = wizard.steps.length; // l'étape « récap » porte l'index = total
    var onRecap = wizard.stepIndex >= total;

    host.appendChild(renderStepMarkers(onRecap));

    var card = el("div", { class: "card" });
    if (onRecap) card.appendChild(renderRecap());
    else card.appendChild(renderStep(wizard.steps[wizard.stepIndex]));
    host.appendChild(card);

    host.appendChild(renderWizardActions(onRecap));
  }

  function renderStepMarkers(onRecap) {
    var bar = el("div", { class: "steps" });
    var labels = wizard.steps.map(function (s, i) { return { name: s.title, idx: i }; });
    labels.push({ name: "Récapitulatif", idx: wizard.steps.length });

    labels.forEach(function (lab, i) {
      var state = "";
      if (lab.idx === wizard.stepIndex) state = "is-current";
      else if (lab.idx < wizard.stepIndex) state = "is-done";

      var num = el("span", { class: "step-node__num", text: pad(i + 1) });
      var node = el("div", { class: "step-node " + state }, [num, el("span", { text: lab.name })]);
      bar.appendChild(node);
      if (i < labels.length - 1) bar.appendChild(el("span", { class: "step-line" }));
    });
    return bar;
  }

  function renderStep(step) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("div", { class: "step-head" }, [
      el("h3", { class: "step-title", text: step.title || "" })
    ]));
    if (step.subtitle) frag.appendChild(el("p", { class: "step-sub", text: step.subtitle }));

    var type = step.type === "single" ? "single" : "multi";
    var box = el("div", { class: "options" });

    (step.options || []).forEach(function (opt) {
      var checked = !!wizard.selections[step.id][opt.id];
      var row = el("div", {
        class: "opt" + (checked ? " is-checked" : ""),
        "data-type": type,
        role: type === "single" ? "radio" : "checkbox",
        "aria-checked": checked ? "true" : "false",
        tabindex: "0"
      }, [
        el("span", { class: "opt__mark" }),
        el("div", { class: "opt__body" }, [
          el("div", { class: "opt__label", text: opt.label || opt.id }),
          opt.description ? el("div", { class: "opt__desc", text: opt.description }) : null
        ])
      ]);
      var toggle = function () { toggleOption(step, opt.id, type); };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (ev) {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(); }
      });
      box.appendChild(row);
    });

    frag.appendChild(box);
    return frag;
  }

  function toggleOption(step, optId, type) {
    var sel = wizard.selections[step.id];
    if (type === "single") {
      var was = !!sel[optId];
      wizard.selections[step.id] = {};
      if (!was) wizard.selections[step.id][optId] = true;
    } else {
      if (sel[optId]) delete sel[optId];
      else sel[optId] = true;
    }
    renderWizard();
  }

  function renderRecap() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("h3", { class: "step-title", text: "Récapitulatif" }));
    frag.appendChild(el("p", { class: "step-sub", text: "Vérifie ta configuration, puis affiche les liens de téléchargement." }));

    var recap = el("div", { class: "recap" });
    wizard.steps.forEach(function (step) {
      var chosen = (step.options || []).filter(function (o) { return wizard.selections[step.id][o.id]; });
      var group = el("div", { class: "recap__group" }, [
        el("div", { class: "recap__h", text: step.title })
      ]);
      if (chosen.length) {
        var ul = el("ul", { class: "recap__list" });
        chosen.forEach(function (o) { ul.appendChild(el("li", { class: "recap__item", text: o.label || o.id })); });
        group.appendChild(ul);
      } else {
        group.appendChild(el("div", { class: "recap__empty", text: "Aucune sélection" }));
      }
      recap.appendChild(group);
    });
    frag.appendChild(recap);

    // zone des liens (remplie au clic sur Télécharger)
    frag.appendChild(el("div", { id: "dlZone" }));
    return frag;
  }

  function renderWizardActions(onRecap) {
    var actions = el("div", { class: "wizard-actions" });

    var back = el("button", {
      class: "btn btn--ghost",
      text: "\u25C2 Retour",
      onClick: function () { if (wizard.stepIndex > 0) { wizard.stepIndex--; renderWizard(); } }
    });
    back.disabled = wizard.stepIndex === 0;
    actions.appendChild(back);

    if (onRecap) {
      actions.appendChild(el("button", {
        class: "btn",
        text: "Afficher les liens \u25BE",
        onClick: showDownloadLinks
      }));
    } else {
      var step = wizard.steps[wizard.stepIndex];
      var needsChoice = step.type === "single";
      var hasChoice = Object.keys(wizard.selections[step.id]).length > 0;
      var next = el("button", {
        class: "btn",
        text: "Suivant \u25B8",
        onClick: function () { wizard.stepIndex++; renderWizard(); }
      });
      next.disabled = needsChoice && !hasChoice;
      actions.appendChild(next);
    }
    return actions;
  }

  function showDownloadLinks() {
    var zone = $("#dlZone");
    if (!zone) return;
    clear(zone);

    var links = [];
    wizard.steps.forEach(function (step) {
      (step.options || []).forEach(function (opt) {
        if (wizard.selections[step.id][opt.id]) {
          (opt.links || []).forEach(function (lnk) { links.push(lnk); });
        }
      });
    });

    if (!links.length) {
      zone.appendChild(el("p", { class: "recap__empty", text: "Sélectionne au moins une édition ou un module pour obtenir des liens." }));
      return;
    }

    var list = el("div", { class: "dl" });
    links.forEach(function (lnk) {
      var src = (lnk.label || "").split("\u2014")[0].trim() || "Lien";
      list.appendChild(el("a", {
        class: "dl__row", href: lnk.url || "#", target: "_blank", rel: "noopener noreferrer"
      }, [
        el("span", { class: "dl__icon", text: "\u2193" }),
        el("span", { class: "dl__label", text: lnk.label || lnk.url }),
        el("span", { class: "dl__src", text: src })
      ]));
    });
    zone.appendChild(list);
  }

  /* =======================================================================
     ONGLET LISTE — liste numérotée + recherche temps réel
     ======================================================================= */
  function loadListe() {
    loaded.liste = true;
    var host = $("#listeHost");
    fetchJSON("data/liste.json")
      .then(function (entries) {
        renderListe(Array.isArray(entries) ? entries : []);
      })
      .catch(function (e) {
        clear(host);
        host.appendChild(el("p", { class: "list-empty", text: "Impossible de charger la liste (" + e.message + ")." }));
      });
  }

  function renderListe(entries) {
    var host = $("#listeHost");
    clear(host);

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

  /* =======================================================================
     ONGLET CHANGELOG — versions décroissantes
     ======================================================================= */
  function loadChangelog() {
    loaded.changelog = true;
    var host = $("#logHost");
    fetchJSON("data/changelog.json")
      .then(function (entries) {
        var list = (Array.isArray(entries) ? entries.slice() : []).sort(function (a, b) {
          return cmpVersion(b.version, a.version);
        });
        renderChangelog(list);
      })
      .catch(function (e) {
        clear(host);
        host.appendChild(el("p", { class: "list-empty", text: "Impossible de charger le changelog (" + e.message + ")." }));
      });
  }

  function renderChangelog(entries) {
    var host = $("#logHost");
    clear(host);
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
     ONGLET CONTACT — Formspree, zéro backend
     ======================================================================= */
  function setupContact() {
    var btn = $("#contactSend");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var name = $("#cName").value.trim();
      var email = $("#cEmail").value.trim();
      var message = $("#cMessage").value.trim();
      var notice = $("#contactNotice");
      notice.className = "notice";

      if (!name || !email || !message) {
        showNotice(notice, "err", "Renseigne le nom, l'email et le message avant d'envoyer.");
        return;
      }
      if (!config.formspree_id || config.formspree_id.indexOf("REMPLACER") === 0) {
        showNotice(notice, "err", "Formulaire non configuré : ajoute ton ID Formspree dans data/config.json.");
        return;
      }

      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = "Envoi\u2026";

      fetch("https://formspree.io/f/" + config.formspree_id, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, email: email, message: message })
      })
        .then(function (r) {
          if (r.ok) {
            showNotice(notice, "ok", "Message envoyé. Merci, une réponse suivra dès que possible.");
            $("#cName").value = ""; $("#cEmail").value = ""; $("#cMessage").value = "";
          } else {
            return r.json().then(function (d) {
              var msg = (d && d.errors && d.errors[0] && d.errors[0].message) || "Échec de l'envoi. Réessaie plus tard.";
              showNotice(notice, "err", msg);
            });
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
     ONGLET ADMIN — éditeurs JSON → Cloudflare Worker
     Aucun stockage : le mot de passe part avec chaque requête, point.
     ======================================================================= */
  var ADMIN_FILES = [
    { key: "files", file: "files.json", label: "Configurateur (Files)" },
    { key: "liste", file: "liste.json", label: "Liste" },
    { key: "changelog", file: "changelog.json", label: "Changelog" },
    { key: "config", file: "config.json", label: "Configuration" }
  ];

  function loadAdmin() {
    loaded.admin = true;
    var host = $("#adminEditors");
    clear(host);

    ADMIN_FILES.forEach(function (entry) {
      var ta = el("textarea", { class: "textarea textarea--code", spellcheck: "false", "aria-label": entry.label });
      var status = el("span", { class: "editor__status" });
      var save = el("button", { class: "btn btn--amber", text: "Enregistrer" });

      // chargement de la version courante (toujours fraîche)
      ta.value = "Chargement\u2026";
      ta.disabled = true;
      fetch("data/" + entry.file, { cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          try { ta.value = JSON.stringify(JSON.parse(txt), null, 2); }
          catch (e) { ta.value = txt; }
          ta.disabled = false;
        })
        .catch(function () { ta.value = ""; ta.disabled = false; });

      save.addEventListener("click", function () { saveEditor(entry, ta, status, save); });

      host.appendChild(el("div", { class: "editor" }, [
        el("div", { class: "editor__head" }, [
          el("span", { class: "editor__name", text: entry.label }),
          el("span", { class: "editor__path", text: "data/" + entry.file })
        ]),
        ta,
        el("div", { class: "editor__foot" }, [save, status])
      ]));
    });
  }

  function saveEditor(entry, ta, status, btn) {
    setStatus(status, "work", "Validation\u2026");

    // 1) validation JSON côté client (retour immédiat)
    var parsed;
    try { parsed = JSON.parse(ta.value); }
    catch (e) { setStatus(status, "err", "JSON invalide : " + e.message); return; }

    // 2) reformatage propre avant envoi
    var content = JSON.stringify(parsed, null, 2) + "\n";
    ta.value = content.replace(/\n$/, "");

    var pwd = $("#adminPwd").value;
    if (!pwd) { setStatus(status, "err", "Saisis le mot de passe admin."); return; }
    if (!config.worker_url || config.worker_url.indexOf("VOTRE-SOUS-DOMAINE") !== -1) {
      setStatus(status, "err", "worker_url non configuré dans data/config.json.");
      return;
    }

    btn.disabled = true;
    setStatus(status, "work", "Envoi vers le Worker\u2026");

    fetch(config.worker_url.replace(/\/$/, "") + "/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd, filename: entry.file, content: content })
    })
      .then(function (r) {
        return r.json().catch(function () { return { error: "Réponse illisible (HTTP " + r.status + ")" }; })
          .then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function (res) {
        if (res.ok && res.data && res.data.success) {
          setStatus(status, "ok", "Enregistré. Le site se mettra à jour sous peu (cache GitHub Pages).");
        } else if (res.status === 401) {
          setStatus(status, "err", "Mot de passe refusé.");
        } else if (res.status === 429) {
          setStatus(status, "err", "Trop de tentatives. Réessaie dans quelques minutes.");
        } else {
          setStatus(status, "err", (res.data && res.data.error) || ("Échec (HTTP " + res.status + ")"));
        }
      })
      .catch(function () { setStatus(status, "err", "Worker injoignable. Vérifie l'URL et le déploiement."); })
      .then(function () { btn.disabled = false; });
  }

  function setStatus(node, kind, text) {
    node.className = "editor__status editor__status--" + kind;
    node.textContent = text;
  }

  // ---- divers ------------------------------------------------------------
  function pad(n) { n = Number(n) || 0; return (n < 10 ? "0" : "") + n; }

})();

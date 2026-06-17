/**
 * GAMMA · Traduction FR — Cloudflare Worker
 * ----------------------------------------------------------------------------
 * Intermédiaire sécurisé entre le panneau admin (navigateur) et l'API GitHub.
 * Le token GitHub et le mot de passe admin restent côté serveur (Secrets) et ne
 * transitent jamais vers le client.
 *
 * Endpoints :
 *   POST /verify    { password }                         → { success } | { error }
 *   POST /contact   { pseudo?, motif, objet, message }   → { success } | { error }   (public)
 *   POST /messages  { password, action?, key? }          → { messages } | { success } | { error }
 *   POST /load      { password, filename }               → { content, sha } | { error }
 *   POST /update    { password, filename, content, sha? }→ { success, sha } | { error } (409 = conflit)
 *   POST /presence  { action:"count" } (public)          → { count, editing }
 *                   { password, id, action:"ping"|"leave", editing? } (admin) → { count, editing }
 * (/verify = login ; /contact = dépôt public d'un message sans email, stocké en KV ;
 *  /load = lecture + SHA pour le verrouillage optimiste de /update ; /presence = compteur d'admins.)
 *
 * Variables d'environnement (Cloudflare Secrets / Vars) :
 *   ADMIN_PASSWORD   (Secret)  mot de passe admin en clair (comparé en timing-safe)
 *   GITHUB_TOKEN     (Secret)  jeton GitHub à portée « repo » (fine-grained: Contents RW)
 *   GITHUB_OWNER     (Var)     propriétaire du dépôt (utilisateur ou orga)
 *   GITHUB_REPO      (Var)     nom du dépôt
 *   ALLOWED_ORIGIN   (Var)     origine GitHub Pages autorisée (ex: https://moi.github.io)
 *   GITHUB_BRANCH    (Var, opt) branche cible (défaut: main)
 *   DATA_DIR         (Var, opt) dossier des JSON dans le dépôt (défaut: data)
 *
 * Bindings KV :
 *   MESSAGES         (KV)       stockage des messages de contact (requis pour /contact et /messages)
 *   RATE_LIMIT       (KV, opt)  limitation par IP. Si absent → repli mémoire.
 * ----------------------------------------------------------------------------
 */

// Seuls ces fichiers peuvent être écrits (anti-traversée de chemin / écriture arbitraire).
const ALLOWED_FILES = ["files.json", "changelog.json", "config.json", "planner.json", "admins.json", "board.json"];

// patch.json d'un mod, éditable depuis l'onglet Liste (admin). Le segment <id>
// (nom de dossier) ne peut contenir ni « / » ni être « . »/« .. » seuls : pas de
// traversée de chemin ni d'écriture en dehors de ce gabarit précis.
const PATCH_FILE_RE = /^0\. PatchVF\/GAMMA (?:extra|tweak)\/(?!\.{1,2}\/)[^/]+\/patch\.json$/;

// Liste blanche d'écriture : fichiers de données OU patch.json d'un mod.
function isAllowedFile(filename) {
  return ALLOWED_FILES.indexOf(filename) !== -1 || PATCH_FILE_RE.test(filename);
}

const MAX_FAILS = 5;          // blocage après 5 échecs
const FAIL_WINDOW = 15 * 60;  // fenêtre glissante, en secondes
const MAX_BODY = 512 * 1024;  // garde-fou : 512 Ko max par payload

// Présence admin (compteur « N en ligne » + indicateur d'édition en cours).
// Le minimum imposé par Cloudflare KV pour expirationTtl est 60 s. On vise plus
// large pour espacer le heartbeat (donc moins d'écritures KV) : le client pingue
// toutes les 50 s (PRESENCE_MS) et la clé n'expire qu'après PRESENCE_TTL, ce qui
// laisse une marge confortable même si un battement est légèrement retardé.
const PRESENCE_TTL = 120;     // une session expire après 120 s sans heartbeat

// Mise en cache (cache de bord Cloudflare) de la réponse publique « count ». Les
// lectures publiques répétées sont servies depuis le cache sans toucher au KV
// (pas de kv.list), ce qui préserve le quota « list » du free tier. Le compteur
// public peut être périmé d'au plus cette durée — sans importance pour un simple
// indicateur de présence.
const PRESENCE_COUNT_TTL = 30; // secondes

// Contact (stockage KV MESSAGES) — formulaire public, sans email.
const MOTIFS = ["Suggestion", "Correction", "Autre"];
const MAX_PSEUDO = 80, MAX_OBJET = 200, MAX_MSG = 5000;
const MAX_CONTACT = 8;          // messages max par IP et par fenêtre
const CONTACT_WINDOW = 60 * 60; // fenêtre contact, en secondes

// Repli mémoire si KV non configuré (best-effort, non partagé entre isolats).
const memFails = new Map(); // ip -> { count, exp }

/* ===================== Validation de schéma ===================== */
/**
 * Au-delà de la validité syntaxique, vérifie que le JSON a la *forme* attendue
 * pour chaque fichier. Sans ça, un collage de structure incorrecte (ex. un objet
 * là où le site attend un tableau) serait accepté et casserait silencieusement
 * l'affichage. Renvoie un message d'erreur (string) ou null si tout est conforme.
 */
function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function validateSchema(filename, data) {
  if (PATCH_FILE_RE.test(filename)) {
    if (!isObject(data)) return "patch.json doit être un objet.";
    if (typeof data.name !== "string" || data.name.trim() === "") return "patch.json : champ « name » (texte non vide) requis.";
    const strFields = ["description", "date", "version", "url"];
    for (let i = 0; i < strFields.length; i++) {
      const k = strFields[i];
      if (data[k] !== undefined && typeof data[k] !== "string") return "patch.json : « " + k + " » doit être un texte.";
    }
    if (data.priority !== undefined && typeof data.priority !== "number") return "patch.json : « priority » doit être un nombre.";
    return null;
  }
  switch (filename) {
    case "changelog.json": {
      if (!Array.isArray(data)) return "changelog.json doit être un tableau.";
      for (let i = 0; i < data.length; i++) {
        if (!isObject(data[i])) return "changelog.json[" + i + "] doit être un objet.";
        if (typeof data[i].version !== "string") return "changelog.json[" + i + "] : champ « version » (texte) requis.";
        if (data[i].changes !== undefined && !Array.isArray(data[i].changes)) return "changelog.json[" + i + "] : « changes » doit être un tableau.";
      }
      return null;
    }
    case "files.json":
      if (!isObject(data)) return "files.json doit être un objet.";
      if (data.readme !== undefined && typeof data.readme !== "string") return "files.json : « readme » doit être un texte.";
      return null;
    case "board.json":
      if (!isObject(data)) return "board.json doit être un objet.";
      if (data.title !== undefined && typeof data.title !== "string") return "board.json : « title » doit être un texte.";
      if (data.body !== undefined && typeof data.body !== "string") return "board.json : « body » doit être un texte.";
      if (data.updated !== undefined && typeof data.updated !== "string") return "board.json : « updated » doit être un texte.";
      return null;
    case "config.json":
      if (!isObject(data)) return "config.json doit être un objet.";
      return null;
    case "planner.json":
      if (!isObject(data)) return "planner.json doit être un objet.";
      if (data.categories !== undefined && !Array.isArray(data.categories)) return "planner.json : « categories » doit être un tableau.";
      if (data.labels !== undefined && !Array.isArray(data.labels)) return "planner.json : « labels » doit être un tableau.";
      return null;
    case "admins.json": {
      if (!Array.isArray(data)) return "admins.json doit être un tableau de pseudos.";
      for (let i = 0; i < data.length; i++) {
        if (typeof data[i] !== "string" || data[i].trim() === "") return "admins.json[" + i + "] : pseudo (texte non vide) attendu.";
      }
      return null;
    }
    default:
      return null;
  }
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "";

    // --- préflight CORS ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (request.method !== "POST") {
      return json({ error: "Méthode non autorisée (POST attendu)." }, 405, origin);
    }

    // --- route /verify : login (vérifie le mot de passe, n'écrit rien) ---
    if (url.pathname === "/verify") {
      return handleVerify(request, env, origin);
    }

    // --- route /contact : dépôt public d'un message (stockage KV, sans email) ---
    if (url.pathname === "/contact") {
      return handleContact(request, env, origin);
    }

    // --- route /messages : boîte de réception admin (liste / suppression) ---
    if (url.pathname === "/messages") {
      return handleMessages(request, env, origin);
    }

    // --- route /presence : compteur d'admins en ligne (count public, ping/leave admin) ---
    if (url.pathname === "/presence") {
      return handlePresence(request, env, origin);
    }

    // --- route /load : lecture authentifiée d'un fichier (contenu + SHA pour le verrouillage) ---
    if (url.pathname === "/load") {
      return handleLoad(request, env, origin);
    }

    if (url.pathname !== "/update") {
      return json({ error: "Endpoint introuvable. Utilise POST /update, /verify, /load, /presence, /contact ou /messages." }, 404, origin);
    }

    // --- garde-fou taille ---
    const len = Number(request.headers.get("content-length") || "0");
    if (len > MAX_BODY) {
      return json({ error: "Payload trop volumineux." }, 413, origin);
    }

    // --- parse du corps ---
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ error: "Corps JSON invalide." }, 400, origin);
    }

    const password = typeof body.password === "string" ? body.password : "";
    const filename = typeof body.filename === "string" ? body.filename : "";
    const content = typeof body.content === "string" ? body.content : "";
    // Verrouillage optimiste : version (SHA GitHub) chargée par le client.
    //   string → on exige cette version ; null → on exige que le fichier n'existe pas ;
    //   undefined (absent) → pas de verrouillage (compat : repli sur retry).
    const expectedSha = typeof body.sha === "string" ? body.sha : (body.sha === null ? null : undefined);

    // --- validation du nom de fichier (liste blanche stricte) ---
    if (!isAllowedFile(filename)) {
      return json({ error: "Fichier non autorisé." }, 400, origin);
    }

    // --- validation du contenu : JSON valide ET forme attendue pour le fichier ---
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      return json({ error: "Le contenu n'est pas un JSON valide." }, 400, origin);
    }
    const schemaErr = validateSchema(filename, parsed);
    if (schemaErr) return json({ error: schemaErr }, 400, origin);

    // --- limitation de débit par IP ---
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const fails = await getFails(env, ip);
    if (fails >= MAX_FAILS) {
      return json({ error: "Trop de tentatives. Réessaie plus tard." }, 429, origin);
    }

    // --- vérification du mot de passe (comparaison à temps constant) ---
    const expected = env.ADMIN_PASSWORD || "";
    const ok = expected.length > 0 && (await timingSafeEqual(password, expected));
    if (!ok) {
      const n = await bumpFails(env, ip);
      const remaining = Math.max(0, MAX_FAILS - n);
      return json(
        { error: "Mot de passe incorrect." + (remaining ? " Tentatives restantes : " + remaining + "." : "") },
        401,
        origin
      );
    }

    // succès d'authentification → on remet le compteur à zéro. Uniquement s'il y
    // a réellement un compteur (fails > 0) : sinon le kv.delete est inutile et
    // grignote pour rien le quota « delete » (1 000/j) à chaque appel — ping de
    // présence ET enregistrement automatique passant par /update inclus.
    if (fails > 0) await resetFails(env, ip);

    // --- push GitHub ---
    try {
      const sha = await pushToGitHub(env, filename, content, expectedSha);
      return json({ success: true, file: filename, sha: sha }, 200, origin);
    } catch (err) {
      if (err && err.conflict) {
        return json({ error: "Le fichier a été modifié par un autre admin depuis ton chargement. Recharge l'éditeur avant d'enregistrer pour ne rien écraser." }, 409, origin);
      }
      return json({ error: "Échec GitHub : " + (err && err.message ? err.message : "inconnu") }, 502, origin);
    }
  }
};

/* ============================ Login (/verify) ============================ */
/**
 * Vérifie uniquement le mot de passe (même garde-fous que /update : limitation
 * de débit par IP + comparaison à temps constant). N'écrit rien sur GitHub.
 */
async function handleVerify(request, env, origin) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_BODY) return json({ error: "Payload trop volumineux." }, 413, origin);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Corps JSON invalide." }, 400, origin); }
  const password = typeof body.password === "string" ? body.password : "";

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const fails = await getFails(env, ip);
  if (fails >= MAX_FAILS) return json({ error: "Trop de tentatives. Réessaie plus tard." }, 429, origin);

  const expected = env.ADMIN_PASSWORD || "";
  const ok = expected.length > 0 && (await timingSafeEqual(password, expected));
  if (!ok) {
    const n = await bumpFails(env, ip);
    const remaining = Math.max(0, MAX_FAILS - n);
    return json(
      { error: "Mot de passe incorrect." + (remaining ? " Tentatives restantes : " + remaining + "." : "") },
      401,
      origin
    );
  }
  if (fails > 0) await resetFails(env, ip);
  return json({ success: true }, 200, origin);
}

/* ============================ Contact (/contact) ============================ */
/**
 * Dépôt public d'un message (aucun mot de passe requis). Validation stricte +
 * limite par IP, puis stockage dans le KV MESSAGES. Aucun email n'est envoyé.
 */
async function handleContact(request, env, origin) {
  const kv = env.MESSAGES;
  if (!kv) return json({ error: "Stockage des messages non configuré (binding KV MESSAGES manquant)." }, 503, origin);

  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_BODY) return json({ error: "Message trop volumineux." }, 413, origin);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Corps JSON invalide." }, 400, origin); }

  // honeypot : champ caché « website » rempli ⇒ bot. Faux succès, rien n'est stocké.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ success: true }, 200, origin);
  }

  const pseudo = String(body.pseudo || "").trim().slice(0, MAX_PSEUDO);
  const motif = String(body.motif || "").trim();
  const objet = String(body.objet || "").trim();
  const message = String(body.message || "").trim();

  if (MOTIFS.indexOf(motif) === -1) return json({ error: "Motif invalide." }, 400, origin);
  if (!objet) return json({ error: "Objet requis." }, 400, origin);
  if (!message) return json({ error: "Message requis." }, 400, origin);
  if (objet.length > MAX_OBJET || message.length > MAX_MSG) return json({ error: "Objet ou message trop long." }, 413, origin);

  // anti-spam : compteur glissant par IP
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const n = parseInt((await kv.get("csub:" + ip)) || "0", 10) || 0;
  if (n >= MAX_CONTACT) return json({ error: "Trop de messages envoyés depuis cette adresse. Réessaie plus tard." }, 429, origin);
  await kv.put("csub:" + ip, String(n + 1), { expirationTtl: CONTACT_WINDOW });

  const id = new Date().toISOString() + "_" + Math.random().toString(36).slice(2, 8);
  const rec = { date: new Date().toISOString(), pseudo: pseudo, motif: motif, objet: objet, message: message };
  await kv.put("msg:" + id, JSON.stringify(rec));

  return json({ success: true }, 200, origin);
}

/* ==================== Boîte de réception admin (/messages) ==================== */
/**
 * Protégé par mot de passe (mêmes garde-fous que /update). action "list" (défaut)
 * renvoie les messages ; action "delete" + key supprime un message. Jamais public.
 */
async function handleMessages(request, env, origin) {
  const kv = env.MESSAGES;
  if (!kv) return json({ error: "Stockage des messages non configuré (binding KV MESSAGES manquant)." }, 503, origin);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Corps JSON invalide." }, 400, origin); }

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const fails = await getFails(env, ip);
  if (fails >= MAX_FAILS) return json({ error: "Trop de tentatives. Réessaie plus tard." }, 429, origin);

  const password = typeof body.password === "string" ? body.password : "";
  const expected = env.ADMIN_PASSWORD || "";
  const ok = expected.length > 0 && (await timingSafeEqual(password, expected));
  if (!ok) {
    const c = await bumpFails(env, ip);
    const remaining = Math.max(0, MAX_FAILS - c);
    return json({ error: "Mot de passe incorrect." + (remaining ? " Tentatives restantes : " + remaining + "." : "") }, 401, origin);
  }
  if (fails > 0) await resetFails(env, ip);

  const action = typeof body.action === "string" ? body.action : "list";

  if (action === "delete") {
    const key = typeof body.key === "string" ? body.key : "";
    if (key.indexOf("msg:") !== 0) return json({ error: "Clé invalide." }, 400, origin);
    await kv.delete(key);
    return json({ success: true }, 200, origin);
  }

  // Liste paginée : kv.list plafonne à 1000 clés par appel → on boucle sur le
  // curseur pour tout récupérer (sinon les plus anciens messages disparaîtraient),
  // puis on lit les valeurs en parallèle plutôt qu'une par une.
  const keys = [];
  let cursor;
  do {
    const listing = await kv.list({ prefix: "msg:", cursor });
    for (const k of listing.keys) keys.push(k.name);
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);

  const items = (await Promise.all(keys.map(async function (name) {
    const v = await kv.get(name);
    if (!v) return null;
    try { const o = JSON.parse(v); o.key = name; return o; } catch (_) { return null; }
  }))).filter(Boolean);

  items.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return json({ messages: items }, 200, origin);
}

/* ====================== Vérification admin (commune) ====================== */
/**
 * Garde-fous partagés : limite de débit par IP + mot de passe en temps constant.
 * Renvoie null si OK, sinon une Response d'erreur prête à retourner.
 */
async function requireAdmin(request, env, origin, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const fails = await getFails(env, ip);
  if (fails >= MAX_FAILS) return json({ error: "Trop de tentatives. Réessaie plus tard." }, 429, origin);

  const expected = env.ADMIN_PASSWORD || "";
  const password = typeof body.password === "string" ? body.password : "";
  const ok = expected.length > 0 && (await timingSafeEqual(password, expected));
  if (!ok) {
    const n = await bumpFails(env, ip);
    const remaining = Math.max(0, MAX_FAILS - n);
    return json({ error: "Mot de passe incorrect." + (remaining ? " Tentatives restantes : " + remaining + "." : "") }, 401, origin);
  }
  if (fails > 0) await resetFails(env, ip);
  return null;
}

/* ============================ Load (/load) ============================ */
/**
 * Lecture authentifiée d'un fichier de la liste blanche, directement depuis le
 * dépôt (source que les écritures). Renvoie { content, sha } : le SHA sert de
 * jeton de version pour le verrouillage optimiste à l'enregistrement.
 */
async function handleLoad(request, env, origin) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_BODY) return json({ error: "Payload trop volumineux." }, 413, origin);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Corps JSON invalide." }, 400, origin); }

  const denied = await requireAdmin(request, env, origin, body);
  if (denied) return denied;

  const filename = typeof body.filename === "string" ? body.filename : "";
  if (!isAllowedFile(filename)) return json({ error: "Fichier non autorisé." }, 400, origin);

  try {
    const r = await readFromGitHub(env, filename);
    return json({ content: r.content, sha: r.sha }, 200, origin);
  } catch (err) {
    return json({ error: "Échec GitHub : " + (err && err.message ? err.message : "inconnu") }, 502, origin);
  }
}

/* ========================== Présence (/presence) ========================== */
/**
 * action "count" (publique, sans mot de passe) → { count, editing } pour afficher
 * le compteur d'admins en ligne sur le site. action "ping"/"leave" (admin) met à
 * jour la présence de la session. L'état « édition en cours » est stocké dans la
 * métadonnée KV de chaque clé (pas de lecture supplémentaire).
 */
function presenceKV(env) { return env.RATE_LIMIT || env.MESSAGES || null; }

async function readPresence(kv) {
  let count = 0, editing = 0, cursor;
  do {
    const listing = await kv.list({ prefix: "pres:", cursor });
    for (const k of listing.keys) {
      count++;
      if (k.metadata && k.metadata.e) editing++;
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
  return { count, editing };
}

async function handlePresence(request, env, origin) {
  const kv = presenceKV(env);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Corps JSON invalide." }, 400, origin); }

  if (!kv) return json({ count: 0, editing: 0 }, 200, origin); // pas de KV → présence non suivie

  const action = typeof body.action === "string" ? body.action : "count";

  // Lecture publique du compteur (aucun mot de passe). Servie via le cache de
  // bord Cloudflare : sur un « hit », aucune opération KV n'est consommée ; sur
  // un « miss », un seul kv.list alimente le cache pour PRESENCE_COUNT_TTL s. Une
  // seule origine est autorisée (ALLOWED_ORIGIN), donc l'en-tête CORS mis en
  // cache est valable pour tous les clients.
  if (action === "count") {
    const cache = caches.default;
    const cacheKey = new Request(new URL("/__presence_count", request.url).toString());
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (_) { /* cache indisponible → repli lecture directe */ }
    const data = await readPresence(kv);
    const resp = new Response(JSON.stringify(data), {
      headers: Object.assign(
        { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "max-age=" + PRESENCE_COUNT_TTL },
        corsHeaders(origin)
      )
    });
    try { await cache.put(cacheKey, resp.clone()); } catch (_) {}
    return resp;
  }

  // ping / leave : réservés aux admins.
  const denied = await requireAdmin(request, env, origin, body);
  if (denied) return denied;

  const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
  if (!id) return json({ error: "Identifiant de session manquant." }, 400, origin);

  if (action === "leave") {
    await kv.delete("pres:" + id);
  } else {
    await kv.put("pres:" + id, "1", { expirationTtl: PRESENCE_TTL, metadata: { e: body.editing ? 1 : 0 } });
  }
  return json(await readPresence(kv), 200, origin);
}

/* ============================ GitHub ============================ */

function ghConf(env) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO, token = env.GITHUB_TOKEN;
  if (!owner || !repo || !token) throw new Error("Variables GitHub manquantes (OWNER / REPO / TOKEN).");
  const branch = env.GITHUB_BRANCH || "main";
  return { owner, repo, token, branch };
}

// Chemin réel dans le dépôt : les fichiers de données vivent sous DATA_DIR ;
// les patch.json d'un mod portent déjà leur chemin complet.
function repoPathFor(env, filename) {
  if (PATCH_FILE_RE.test(filename)) return filename;
  const dir = (env.DATA_DIR || "data").replace(/^\/+|\/+$/g, "");
  return dir + "/" + filename;
}

function ghHeaders(token) {
  return {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github+json",
    "User-Agent": "gamma-fr-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function ghUrl(c, repoPath) {
  return "https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/" + encodeURI(repoPath);
}

// Lit un fichier du dépôt : { content (texte décodé), sha }. sha=null si absent.
async function readFromGitHub(env, filename) {
  const c = ghConf(env);
  const repoPath = repoPathFor(env, filename);
  const res = await fetch(ghUrl(c, repoPath) + "?ref=" + encodeURIComponent(c.branch), { headers: ghHeaders(c.token) });
  if (res.status === 404) return { content: "", sha: null };
  if (res.status !== 200) throw new Error("lecture (HTTP " + res.status + ")");
  const meta = await res.json();
  return { content: fromBase64(meta.content || ""), sha: meta.sha || null };
}

/**
 * Écrit un fichier et renvoie le nouveau SHA.
 *   expectedSha défini (string|null) → verrouillage optimiste : si la version
 *     actuelle du dépôt diffère, on lève une erreur `.conflict` (rien n'est écrasé).
 *   expectedSha === undefined → compat : on relit le SHA et on réessaie une fois
 *     sur course (double-clic du même admin), sans garantie anti-écrasement.
 */
async function pushToGitHub(env, filename, content, expectedSha) {
  const c = ghConf(env);
  const repoPath = repoPathFor(env, filename);
  const url = ghUrl(c, repoPath);
  const headers = ghHeaders(c.token);
  const encoded = toBase64(content);

  async function currentSha() {
    const res = await fetch(url + "?ref=" + encodeURIComponent(c.branch), { headers });
    if (res.status === 200) return (await res.json()).sha;
    if (res.status === 404) return null;
    throw new Error("lecture SHA (HTTP " + res.status + ")");
  }
  async function put(sha) {
    const payload = {
      message: "MAJ " + repoPath + " via admin (" + new Date().toISOString() + ")",
      content: encoded,
      branch: c.branch
    };
    if (sha) payload.sha = sha;
    return fetch(url, { method: "PUT", headers, body: JSON.stringify(payload) });
  }
  async function putError(res) {
    let detail = "";
    try { const e = await res.json(); detail = e && e.message ? " — " + e.message : ""; } catch (_) {}
    return new Error("écriture (HTTP " + res.status + ")" + detail);
  }

  if (expectedSha !== undefined) {
    const cur = await currentSha();
    if ((cur || null) !== (expectedSha || null)) { const e = new Error("conflict"); e.conflict = true; throw e; }
    const res = await put(cur);
    if (res.status === 200 || res.status === 201) return (await res.json()).content.sha;
    if (res.status === 409 || res.status === 422) { const e = new Error("conflict"); e.conflict = true; throw e; }
    throw await putError(res);
  }

  let sha = await currentSha();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await put(sha);
    if (res.status === 200 || res.status === 201) return (await res.json()).content.sha;
    if ((res.status === 409 || res.status === 422) && attempt === 0) { sha = await currentSha(); continue; }
    throw await putError(res);
  }
}

// base64 sûr pour l'UTF-8 (accents français inclus)
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Décode le base64 (avec retours à la ligne de l'API GitHub) en texte UTF-8.
function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ===================== Comparaison timing-safe ===================== */
/**
 * On signe les deux chaînes par HMAC-SHA256 avec une clé aléatoire éphémère,
 * puis on compare les deux empreintes (longueur fixe de 32 octets) octet par
 * octet sans court-circuit. La durée ne dépend donc ni du contenu ni de la
 * longueur des mots de passe → pas de fuite par timing attack.
 */
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ha = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/* ===================== Limitation de débit ===================== */

async function getFails(env, ip) {
  if (env.RATE_LIMIT) {
    const v = await env.RATE_LIMIT.get("fail:" + ip);
    return v ? parseInt(v, 10) || 0 : 0;
  }
  const rec = memFails.get(ip);
  if (!rec) return 0;
  if (rec.exp < Date.now()) { memFails.delete(ip); return 0; }
  return rec.count;
}

async function bumpFails(env, ip) {
  if (env.RATE_LIMIT) {
    const n = (await getFails(env, ip)) + 1;
    await env.RATE_LIMIT.put("fail:" + ip, String(n), { expirationTtl: FAIL_WINDOW });
    return n;
  }
  const now = Date.now();
  const rec = memFails.get(ip);
  const n = rec && rec.exp >= now ? rec.count + 1 : 1;
  memFails.set(ip, { count: n, exp: now + FAIL_WINDOW * 1000 });
  return n;
}

async function resetFails(env, ip) {
  if (env.RATE_LIMIT) { await env.RATE_LIMIT.delete("fail:" + ip); return; }
  memFails.delete(ip);
}

/* ===================== CORS / réponses ===================== */

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        // jamais de mise en cache : aucune réponse authentifiée ne doit être partagée/rejouée
        "Cache-Control": "no-store"
      },
      corsHeaders(origin)
    )
  });
}

// Export nommé (ignoré par le runtime Cloudflare) : permet de tester la
// validation de schéma hors navigateur via `import` (voir tests/).
export { validateSchema, isAllowedFile };

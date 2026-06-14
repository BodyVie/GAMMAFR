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
 *   POST /update    { password, filename, content }      → { success } | { error }
 * (/verify = login ; /contact = dépôt public d'un message sans email, stocké en KV.)
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
const ALLOWED_FILES = ["files.json", "liste.json", "changelog.json", "config.json"];

const MAX_FAILS = 5;          // blocage après 5 échecs
const FAIL_WINDOW = 15 * 60;  // fenêtre glissante, en secondes
const MAX_BODY = 512 * 1024;  // garde-fou : 512 Ko max par payload

// Contact (stockage KV MESSAGES) — formulaire public, sans email.
const MOTIFS = ["Suggestion", "Correction", "Autre"];
const MAX_PSEUDO = 80, MAX_OBJET = 200, MAX_MSG = 5000;
const MAX_CONTACT = 8;          // messages max par IP et par fenêtre
const CONTACT_WINDOW = 60 * 60; // fenêtre contact, en secondes

// Repli mémoire si KV non configuré (best-effort, non partagé entre isolats).
const memFails = new Map(); // ip -> { count, exp }

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

    if (url.pathname !== "/update") {
      return json({ error: "Endpoint introuvable. Utilise POST /update, /verify, /contact ou /messages." }, 404, origin);
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

    // --- validation du nom de fichier (liste blanche stricte) ---
    if (ALLOWED_FILES.indexOf(filename) === -1) {
      return json({ error: "Fichier non autorisé." }, 400, origin);
    }

    // --- validation du contenu : doit être un JSON valide ---
    try {
      JSON.parse(content);
    } catch (_) {
      return json({ error: "Le contenu n'est pas un JSON valide." }, 400, origin);
    }

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

    // succès d'authentification → on remet le compteur à zéro
    await resetFails(env, ip);

    // --- push GitHub ---
    try {
      const dir = (env.DATA_DIR || "data").replace(/^\/+|\/+$/g, "");
      const path = dir + "/" + filename;
      await pushToGitHub(env, path, content);
      return json({ success: true, file: path }, 200, origin);
    } catch (err) {
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
  await resetFails(env, ip);
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
  await resetFails(env, ip);

  const action = typeof body.action === "string" ? body.action : "list";

  if (action === "delete") {
    const key = typeof body.key === "string" ? body.key : "";
    if (key.indexOf("msg:") !== 0) return json({ error: "Clé invalide." }, 400, origin);
    await kv.delete(key);
    return json({ success: true }, 200, origin);
  }

  const listing = await kv.list({ prefix: "msg:" });
  const items = [];
  for (const k of listing.keys) {
    const v = await kv.get(k.name);
    if (!v) continue;
    try { const o = JSON.parse(v); o.key = k.name; items.push(o); } catch (_) {}
  }
  items.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return json({ messages: items }, 200, origin);
}

/* ============================ GitHub ============================ */

async function pushToGitHub(env, path, content) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    throw new Error("Variables GitHub manquantes (OWNER / REPO / TOKEN).");
  }

  const base = "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + encodeURI(path);
  const ghHeaders = {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github+json",
    "User-Agent": "gamma-fr-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  // 1) récupérer le SHA actuel (peut ne pas exister encore)
  let sha;
  const getRes = await fetch(base + "?ref=" + encodeURIComponent(branch), { headers: ghHeaders });
  if (getRes.status === 200) {
    const meta = await getRes.json();
    sha = meta.sha;
  } else if (getRes.status !== 404) {
    throw new Error("lecture SHA (HTTP " + getRes.status + ")");
  }

  // 2) PUT du nouveau contenu (base64 UTF-8)
  const payload = {
    message: "MAJ " + path + " via admin (" + new Date().toISOString() + ")",
    content: toBase64(content),
    branch: branch
  };
  if (sha) payload.sha = sha;

  const putRes = await fetch(base, {
    method: "PUT",
    headers: ghHeaders,
    body: JSON.stringify(payload)
  });

  if (putRes.status !== 200 && putRes.status !== 201) {
    let detail = "";
    try { const e = await putRes.json(); detail = e && e.message ? " — " + e.message : ""; } catch (_) {}
    throw new Error("écriture (HTTP " + putRes.status + ")" + detail);
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
      { "Content-Type": "application/json; charset=utf-8" },
      corsHeaders(origin)
    )
  });
}

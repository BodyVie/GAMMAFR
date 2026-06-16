# GAMMA · Traduction FR — site + Cloudflare Worker

Site statique (HTML/CSS/JS pur, zéro framework, zéro dépendance) hébergeable sur
**GitHub Pages**, couplé à un **Cloudflare Worker** qui sert d'intermédiaire
sécurisé pour mettre à jour les données depuis un panneau admin protégé par mot
de passe. Le token GitHub et le mot de passe admin ne sont **jamais** exposés
côté navigateur.

```
Navigateur (admin) ──► mot de passe + JSON
        │
        ▼
Cloudflare Worker ──► vérifie le mot de passe (timing-safe), pousse vers GitHub
        │
        ▼
Dépôt GitHub ──► fichiers JSON mis à jour ──► le site se rafraîchit
```

---

## 1. Arborescence

```
gamma-fr/
├── index.html            # page unique, 7 onglets (accueil = Panneau d'affichage)
├── css/
│   └── style.css         # thème « PDA de la Zone »
├── js/
│   ├── core.js           # logique pure testable (priorités, versions) — sans DOM
│   ├── app.js            # logique (onglets, configurateur, recherche, admin…)
│   └── zip.js            # écriture ZIP en JS pur (sans dépendance)
├── data/
│   ├── files.json        # lisez-moi du configurateur
│   ├── patches.json      # manifeste GÉNÉRÉ (ne pas éditer à la main)
│   ├── liste.json        # liste numérotée
│   ├── changelog.json    # journal des versions
│   ├── planner.json      # planificateur (onglet Planner)
│   ├── board.json        # panneau d'affichage éditable (onglet d'accueil)
│   ├── admins.json       # pseudos admin (sélecteur d'auteur des commentaires planner)
│   └── config.json       # titre, Formspree, Worker, chemins du configurateur
├── assets/               # favicon, icônes PWA, carte de partage (og-image)
├── tools/
│   └── build_manifest.py # génère data/patches.json depuis "0. PatchVF/"
├── tests/                # tests unitaires (node --test, sans dépendance)
├── 0. PatchVF/           # contenu de la traduction (voir §8) — préfixe "0." pour
│                         #   apparaître en tête de liste sur GitHub
│   ├── MainFile/             # squelette copié tel quel dans l'archive
│   ├── GAMMA base/           # fichiers FR de base
│   ├── GAMMA tweak/<patch>/   # XML + patch.json
│   └── GAMMA extra/<patch>/   # XML + patch.json
├── .github/workflows/
│   ├── build-manifest.yml # régénère le manifeste à chaque push (option B)
│   └── test.yml           # lance les tests unitaires (CI)
├── sw.js                 # (neutralisé) désinscrit un ancien service worker
├── worker.js             # Cloudflare Worker (à déployer à part)
├── robots.txt            # SEO : autorise l'indexation, pointe vers le sitemap
├── sitemap.xml           # SEO : plan du site (page unique)
├── package.json          # script de test (npm test → node --test)
└── README.md
```

Les onglets : **Panneau d'affichage** (accueil — annonce éditable par les admins
+ nouveautés du dernier jour de modifications, déduites du changelog **et** du
planner), **Files**
(lisez-moi + configurateur d'installation), **Liste** (liste filtrable),
**Changelog**, **Planner** (planificateur, édition admin), **Contact**, **Admin**
(éditeurs JSON protégés).

---

## 2. Test en local

Les `fetch()` des JSON nécessitent un serveur HTTP (ils ne fonctionnent pas en
ouvrant le fichier via `file://`). Au choix :

```bash
cd gamma-fr
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

L'onglet Admin ne fonctionnera vraiment qu'une fois le Worker déployé (étape 4),
mais le reste du site est entièrement testable en local.

### Tests unitaires

La logique pure (`js/core.js`, `js/zip.js`) est couverte par des tests via le
runner natif de Node (aucune dépendance, aucune installation) :

```bash
node --test        # ou : npm test
```

Couvre la résolution des conflits par priorité, la comparaison de versions, la
génération du ZIP (CRC32 + structure de l'archive) et la validation de schéma du
Worker (`validateSchema`). La CI lance d'abord un lint de syntaxe (`npm run lint`
→ `node --check` sur `js/`, `tests/` et `worker.js`) puis les tests, à chaque
push/PR (`.github/workflows/test.yml`).

---

## 3. Déploiement sur GitHub Pages

1. Crée un dépôt GitHub (ex. `gamma-fr`) et pousse-y le contenu du dossier
   `gamma-fr/` (le fichier `worker.js` peut rester dans le dépôt, il ne gêne pas).
2. Dépôt → **Settings → Pages**.
3. **Source** : `Deploy from a branch`. **Branch** : `main`, dossier `/ (root)`.
   Enregistre.
4. Au bout d'une minute, le site est en ligne à l'une de ces adresses :
   - dépôt nommé `USERNAME.github.io` → `https://USERNAME.github.io`
   - dépôt « projet » (autre nom) → `https://USERNAME.github.io/gamma-fr/`

> Retiens cette URL : son **origine** servira à configurer le CORS du Worker
> (étape 4). L'origine est uniquement le schéma + domaine, **sans le chemin** :
> `https://USERNAME.github.io` (même pour un dépôt projet).

---

## 4. Déploiement du Cloudflare Worker

### 4.1. Créer le token GitHub

Le Worker a besoin d'un jeton pour écrire dans le dépôt.

- **Recommandé — fine-grained token** : GitHub → *Settings → Developer settings →
  Personal access tokens → Fine-grained tokens*. Limité au seul dépôt
  `gamma-fr`, permission **Contents : Read and write**.
- **Classique** : un token avec le scope **`repo`**.

Copie le token, tu ne le reverras plus.

### 4.2. Déployer le Worker

**Option A — Tableau de bord Cloudflare**

1. Cloudflare → **Workers & Pages → Create → Create Worker**. Nomme-le
   (ex. `gamma-fr-update`) et déploie un Worker vide.
2. **Edit code** : colle le contenu de `worker.js`, puis **Deploy**.
3. Note l'URL publique du Worker, du type
   `https://gamma-fr-update.TON-SOUS-DOMAINE.workers.dev`.

**Option B — Wrangler (CLI)**

```bash
npm install -g wrangler
wrangler login
# place worker.js dans un dossier, ajoute un wrangler.toml minimal :
#   name = "gamma-fr-update"
#   main = "worker.js"
#   compatibility_date = "2024-01-01"
wrangler deploy
```

### 4.3. Configurer les variables (Secrets & Vars)

Dans le Worker → **Settings → Variables and Secrets** :

| Nom              | Type            | Valeur                                            |
|------------------|-----------------|---------------------------------------------------|
| `ADMIN_PASSWORD` | **Secret**      | le mot de passe admin de ton choix                |
| `GITHUB_TOKEN`   | **Secret**      | le token créé en 4.1                              |
| `GITHUB_OWNER`   | Variable        | ton nom d'utilisateur GitHub                      |
| `GITHUB_REPO`    | Variable        | `gamma-fr`                                        |
| `ALLOWED_ORIGIN` | Variable        | `https://USERNAME.github.io` (origine, sans chemin)|
| `GITHUB_BRANCH`  | Variable (opt.) | `main` (défaut si absent)                         |
| `DATA_DIR`       | Variable (opt.) | `data` (défaut si absent)                         |

En CLI : `wrangler secret put ADMIN_PASSWORD` (idem `GITHUB_TOKEN`), les
variables non secrètes vont dans `wrangler.toml` sous `[vars]`.

### 4.4. (Optionnel mais conseillé) Limitation de débit robuste via KV

Le Worker bloque une IP après **5 échecs** de mot de passe pendant 15 min. Sans
KV, il utilise un compteur en mémoire (suffisant, mais non partagé entre les
instances Cloudflare). Pour une limitation fiable :

1. Workers & Pages → **KV** → *Create namespace* (ex. `gamma_fr_ratelimit`).
2. Worker → **Settings → Bindings → Add → KV namespace**. Variable name :
   `RATE_LIMIT`, namespace : celui créé.

Le Worker détecte automatiquement le binding `RATE_LIMIT` et l'utilise.

### 4.5. Brancher le site sur le Worker

Édite `data/config.json` et renseigne `worker_url` avec l'URL du Worker (sans
`/update`, le site l'ajoute) :

```json
{
  "site_title": "GAMMAFR",
  "site_tagline": "Localisation française du modpack S.T.A.L.K.E.R. G.A.M.M.A.",
  "formspree_id": "xxxxxxxx",
  "worker_url": "https://gamma-fr-update.TON-SOUS-DOMAINE.workers.dev"
}
```

Pousse la modification : le panneau admin est opérationnel.

---

## 5. Configuration Formspree (onglet Contact)

1. Crée un compte sur [formspree.io](https://formspree.io) et un nouveau
   formulaire.
2. Récupère son identifiant : dans l'URL `https://formspree.io/f/abcdwxyz`,
   l'ID est `abcdwxyz`.
3. Renseigne-le dans `data/config.json` → `formspree_id`.

Le formulaire envoie en arrière-plan (`fetch`) vers Formspree et affiche une
confirmation. Aucun backend à héberger. À la première soumission, Formspree peut
demander une validation par email du compte.

---

## 6. Modifier les données via l'admin

1. Ouvre le site, onglet **Admin** (volontairement discret, à droite de la nav).
2. Saisis le mot de passe (`ADMIN_PASSWORD`). Il n'est **jamais** mémorisé : il
   est renvoyé au Worker à chaque enregistrement, sans session, cookie ni
   `localStorage`.
3. Chaque éditeur charge la version actuelle du fichier. Modifie le JSON.
4. **Enregistrer** : le JSON est d'abord validé côté navigateur (erreur immédiate
   si invalide), puis envoyé au Worker, qui le repousse dans le dépôt.
5. GitHub Pages se reconstruit en ~1 min. Le cache du navigateur/CDN peut
   retarder un peu l'affichage public ; un rechargement forcé (Ctrl+Maj+R) aide.

**Format des fichiers** (modèles déjà fournis dans `data/`) :

- `files.json` : `readme` (texte, `\n` = saut de ligne) + `steps[]`. Chaque
  étape a un `type` `single` (un seul choix) ou `multi` (cases indépendantes),
  et des `options[]` avec `label`, `description`, `links[]` (`label` + `url`).
  L'étape de récapitulatif est générée automatiquement.
- `liste.json` : tableau d'objets `{ id, title, description }`.
- `changelog.json` : tableau `{ version, date, changes[] }`, affiché par version
  décroissante. Alimente aussi les « Nouveautés » du Panneau d'affichage.
- `planner.json` : chaque ticket porte `created` et `modified` (horodatages ISO,
  renseignés automatiquement à la création et à chaque édition). Affichés en tête
  du ticket (« Créé le… » / « Dernière modification le… ») ; les tickets dont le
  jour de dernière modification correspond au jour le plus récent remontent aussi
  dans les « Nouveautés ». Le bloc « Nouveautés » dissocie les deux sources :
  une section **Changelog** (son propre dernier jour de modifications) et une
  section **Planner** (son propre dernier jour), chacune avec sa date.
- `board.json` : panneau d'affichage de l'accueil — `{ title, body, updated }`
  (textes ; `\n` = saut de ligne dans `body`). Édité directement depuis l'onglet
  **Panneau d'affichage** quand un admin est connecté ; `updated` est renseigné
  automatiquement à l'enregistrement.
- `config.json` : `site_title`, `site_tagline`, `formspree_id`, `worker_url`.
- `admins.json` : tableau de pseudos (`["Body", "Thundard"]`). Édité via la bulle
  « Administrateurs » de l'onglet Admin ; alimente la liste déroulante « Auteur »
  des commentaires du Planner.

> Astuce : le Worker n'accepte d'écrire que ces fichiers de la liste blanche et
> refuse tout JSON malformé **ou de forme inattendue** (validation de schéma) — un
> mauvais collage ne peut pas casser le dépôt.

### Édition concurrente (verrouillage optimiste)

Les éditeurs admin chargent chaque fichier via le Worker (`/load`) avec sa version
(SHA GitHub) et la renvoient à l'enregistrement. Si un **autre admin** a modifié le
même fichier entre-temps, l'enregistrement est **refusé** (HTTP 409) avec un message
invitant à recharger — aucune modification n'est écrasée par accident.

Un **compteur d'admins en ligne** s'affiche à droite de l'onglet Admin (visible de
tous), accompagné d'un indicateur **⚠ édition** lorsqu'un admin a une modification en
cours. Un admin connecté se voit toujours lui-même (« 1 en ligne ») et voit
l'indicateur dès qu'il a une modification non enregistrée. Le **décompte partagé
entre sessions** (visiteurs qui voient les admins en ligne, admins qui se voient
entre eux) nécessite en revanche un **binding KV** : `RATE_LIMIT` s'il existe, sinon
`MESSAGES`. **Sans aucun KV lié, le partage est impossible** — chacun ne voit que
sa propre session. Pour l'activer, lie un namespace KV `RATE_LIMIT` au Worker
(voir § 4.4).

---

## 7. Sécurité — pourquoi le token ne fuit pas

- **Le token GitHub ne touche jamais le navigateur.** Il vit dans les *Secrets*
  Cloudflare, côté serveur. Le navigateur n'envoie que `{ password, filename,
  content }` au Worker ; c'est le Worker, et lui seul, qui détient le token et
  appelle l'API GitHub. Inspecter le code du site ou le trafic réseau ne révèle
  aucun secret.
- **Mot de passe comparé à temps constant.** Le Worker ne fait pas `===` sur le
  mot de passe. Il signe les deux valeurs par HMAC-SHA256 avec une clé aléatoire
  éphémère, puis compare les deux empreintes (32 octets, longueur fixe) octet
  par octet sans court-circuit. La durée de la comparaison ne dépend ni du
  contenu ni de la longueur → pas de fuite par *timing attack*.
- **Aucune persistance côté admin.** Pas de `localStorage`, pas de
  `sessionStorage`, pas de cookie. Le mot de passe n'existe que le temps de la
  requête ; fermer l'onglet l'efface.
- **CORS verrouillé.** Le Worker ne renvoie l'en-tête d'autorisation que pour
  l'origine GitHub Pages déclarée (`ALLOWED_ORIGIN`). Une page tierce ne peut pas
  faire appeler le Worker par le navigateur d'un visiteur.
- **Liste blanche d'écriture.** Seuls `files.json`, `liste.json`,
  `changelog.json`, `config.json`, `planner.json` et `admins.json` (dans
  `DATA_DIR`) sont modifiables : pas de traversée de chemin ni d'écriture de
  fichier arbitraire dans le dépôt.
- **Anti-force brute.** Blocage par IP après 5 échecs sur une fenêtre de 15 min
  (KV si configuré, sinon compteur mémoire), avec garde-fou de taille sur le
  payload.

### Bonnes pratiques

- Utilise un mot de passe long et unique pour `ADMIN_PASSWORD`.
- Préfère un **fine-grained token** limité au seul dépôt (permission *Contents*).
- En cas de doute, **révoque** le token GitHub et régénère-en un : rien d'autre
  n'est à changer côté site.
- Le mot de passe admin protège l'**écriture**, pas le contenu : tout le JSON du
  dépôt est public (c'est un site statique). N'y mets jamais d'information
  sensible.

---

## 8. Configurateur d'installation (PatchVF)

L'onglet **Files** assemble une archive de mod **dans le navigateur** à partir du
dossier `0. PatchVF/`. Aucune API GitHub, aucun service externe : sur GitHub Pages,
les fichiers de `0. PatchVF/` sont servis comme le reste du site et récupérés en
relatif. L'archive est construite en JS pur (`js/zip.js`) ; les octets de chaque
fichier sont copiés tels quels, donc l'encodage **windows-1252** est préservé.

### 8.1. Structure de `0. PatchVF/`

```
0. PatchVF/
├── MainFile/                  # squelette : copié tel quel à la racine du ZIP
│   └── (meta.ini, etc.)       #   (laisser vide ⇒ le ZIP ne contient que gamedata/…)
├── GAMMA base/                # fichiers FR de base (directement dedans)
│   └── st_*.xml
├── GAMMA tweak/
│   └── <NomDuPatch>/
│       ├── st_*.xml
│       └── patch.json
└── GAMMA extra/
    └── <NomDuPatch>/
        ├── st_*.xml
        └── patch.json
```

Trois niveaux **cumulatifs** côté site : `base` (base seule) → `tweak` (base +
patchs Tweak) → `extra` (base + patchs Tweak et Extra). À la génération, la
sélection est rangée dans `gamedata/configs/text/fra/`, puis fusionnée avec le
contenu de `MainFile/` (la sélection l'emporte en cas de même chemin).

### 8.2. Le fichier `patch.json`

Un par dossier de `GAMMA tweak/` et `GAMMA extra/` (UTF-8) :

```json
{
  "name": "Dialogues crus",
  "description": "Registre familier et vulgaire pour les dialogues PNJ.",
  "date": "2026-05-12",
  "version": "1.1.0",
  "url": "https://www.moddb.com/mods/…",
  "priority": 50
}
```

- `name` / `description` : affichés et utilisés par la barre de recherche
  (à défaut, le nom du dossier sert de nom).
- `priority` : **entier, le plus élevé gagne**. Si deux patchs sélectionnés
  fournissent un fichier de même nom, celui de priorité supérieure écrase
  l'autre. `GAMMA base` a la priorité la plus basse. En cas d'**égalité** de
  priorité sur un même fichier, le récapitulatif affiche ⚠ et un gagnant
  déterministe est choisi — fixe des priorités distinctes pour lever le doute.

### 8.3. Ajouter / mettre à jour un patch

1. Créer un dossier sous `GAMMA tweak/` ou `GAMMA extra/`.
2. Y déposer les `.xml` (windows-1252) **et** un `patch.json`.
3. Régénérer le manifeste (voir 8.4), puis pousser.

### 8.4. Régénérer `data/patches.json`

Le site lit un manifeste unique `data/patches.json` (1 requête). Deux options :

- **Option A — manuelle (Python)** : avant de pousser,
  ```bash
  python3 tools/build_manifest.py     # depuis la racine du dépôt
  git add data/patches.json && git commit -m "maj manifeste" && git push
  ```
- **Option B — automatique (GitHub Action)** : `.github/workflows/build-manifest.yml`
  régénère et committe `data/patches.json` à chaque push touchant `0. PatchVF/**`.
  Rien à faire manuellement. (Active les Actions sur le dépôt ; l'Action a la
  permission `contents: write`.)

Le manifeste est **généré** : ne pas l'éditer à la main (et il n'est volontairement
pas dans l'onglet Admin, qui régénérerait au prochain build).

### 8.5. Paramètres dans `config.json`

```json
{
  "patch_base": "0. PatchVF",
  "fra_path": "gamedata/configs/text/fra",
  "mod_zip_name": "GAMMAFR-PatchVF"
}
```

`mod_zip_name` = nom du fichier `.zip` téléchargé. `fra_path` = destination de la
sélection dans l'archive. `patch_base` = dossier racine du contenu.

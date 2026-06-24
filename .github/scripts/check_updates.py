#!/usr/bin/env python3
"""
Vérifie si les mods de GAMMA extra ont été mis à jour sur ModDB.

Au lieu de comparer un numéro de version (texte libre, peu fiable), on compare
la DATE « Updated » affichée par ModDB à la date de référence enregistrée
localement dans chaque patch.json (champ « moddb_updated »).

Lit les patch.json, scrape la date « Updated » des pages ModDB, écrit
data/mod_updates.json.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Erreur : installe requests et beautifulsoup4 (pip install requests beautifulsoup4)")
    sys.exit(1)

# curl_cffi imite l'empreinte TLS d'un vrai navigateur Chrome. C'est ce qui
# permet de passer la protection anti-bot Cloudflare de ModDB : sans elle, les
# requêtes émises depuis une IP de datacenter (GitHub Actions) reçoivent un
# 403 Forbidden. Repli automatique sur requests si le module est absent.
try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXTRA_DIR = os.path.join(REPO_ROOT, "0. PatchVF", "GAMMA extra")
OUTPUT_FILE = os.path.join(REPO_ROOT, "data", "mod_updates.json")

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.moddb.com/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def find_patch_jsons(base_dir):
    results = []
    if not os.path.isdir(base_dir):
        return results
    for entry in sorted(os.listdir(base_dir)):
        path = os.path.join(base_dir, entry, "patch.json")
        if os.path.isfile(path):
            results.append((entry, path))
    return results


def parse_moddb_date(text):
    """Convertit une date ModDB en datetime.date, ou None si illisible.

    Accepte les deux formes :
      - le format d'affichage ModDB : « Feb 1st, 2026 » (ou « February 1, 2026 »)
      - une date ISO : « 2026-02-01 » ou « 2026-02-01T11:32:48+00:00 »
    """
    if not text:
        return None
    text = text.strip()

    # 1) ISO en tête : 2026-02-01 (avec ou sans partie horaire)
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).date()
        except ValueError:
            return None

    # 2) Format d'affichage : « Feb 1st, 2026 », « February 1 2026 »…
    m = re.match(r"([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})", text)
    if m:
        mon = MONTHS.get(m.group(1)[:3].lower())
        if mon:
            try:
                return datetime(int(m.group(3)), mon, int(m.group(2))).date()
            except ValueError:
                return None

    return None


def fetch_html(url, attempts=3):
    """Récupère le HTML d'une page en contournant l'anti-bot Cloudflare de ModDB.

    Utilise curl_cffi avec l'empreinte d'un Chrome réel quand il est disponible
    (le plus fiable contre les 403), sinon requests avec un jeu d'en-têtes de
    navigateur. Réessaie avec backoff sur les blocages temporaires (403/429/503).
    Lève une exception si toutes les tentatives échouent.
    """
    last_err = None
    for i in range(attempts):
        try:
            if cffi_requests is not None:
                # impersonate règle déjà l'UA et les en-têtes cohérents avec
                # l'empreinte TLS ; on ajoute juste Referer et la langue.
                resp = cffi_requests.get(
                    url,
                    headers={"Referer": "https://www.moddb.com/",
                             "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"},
                    timeout=20,
                    impersonate="chrome",
                )
            else:
                resp = requests.get(url, headers=BROWSER_HEADERS, timeout=20)

            if resp.status_code in (403, 429, 503):
                last_err = "HTTP " + str(resp.status_code) + " (anti-bot)"
                time.sleep(3 * (i + 1))
                continue
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            last_err = str(e)
            time.sleep(3 * (i + 1))

    raise RuntimeError(last_err or "échec inconnu")


def scrape_moddb_updated(url):
    """Retourne (date, texte_affiché) de la date « Updated » de la page ModDB.

    Structure ModDB ciblée :
        <h5>Updated</h5>
        <span class="summary">
            <time datetime="2026-02-01T11:32:48+00:00">Feb 1st, 2026</time>
        </span>

    On lit en priorité l'attribut « datetime » (ISO, sans ambiguïté), avec repli
    sur le texte visible. Retourne (None, None) en cas d'échec.
    """
    try:
        html = fetch_html(url)
        soup = BeautifulSoup(html, "html.parser")

        for h5 in soup.find_all("h5"):
            if h5.get_text(strip=True).lower() != "updated":
                continue

            # Le <time> est dans le frère immédiat (cas courant)…
            sib = h5.find_next_sibling()
            time_tag = sib.find("time") if sib else None
            # …sinon, premier <time> rencontré après le h5.
            if time_tag is None:
                time_tag = h5.find_next("time")

            if time_tag is not None:
                iso = (time_tag.get("datetime") or "").strip()
                display = time_tag.get_text(strip=True)
                d = parse_moddb_date(iso) or parse_moddb_date(display)
                if d:
                    return d, (display or iso)

        print("  [WARN] Date « Updated » introuvable sur la page : " + url)
        return None, None
    except Exception as e:
        print("  [WARN] Échec du scraping pour " + url + " : " + str(e))
        return None, None


def load_existing(path):
    """Charge le fichier mod_updates.json existant pour préserver les acks."""
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        existing = {}
        for item in data.get("updates", []):
            if "id" in item:
                existing[item["id"]] = item
        return existing
    except Exception:
        return {}


def main():
    patches = find_patch_jsons(EXTRA_DIR)
    if not patches:
        print("Erreur : aucun patch.json trouvé dans " + EXTRA_DIR)
        sys.exit(1)

    existing = load_existing(OUTPUT_FILE)
    updates = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for folder_name, patch_path in patches:
        with open(patch_path, "r", encoding="utf-8") as f:
            patch = json.load(f)

        url = patch.get("url", "")
        date_local = (patch.get("moddb_updated", "") or "").strip()
        name = patch.get("name", folder_name)

        if "moddb.com" not in url:
            print("Ignoré (pas ModDB) : " + name)
            continue

        print("Vérification : " + name + " (" + url + ")")
        remote_date, date_remote = scrape_moddb_updated(url)
        time.sleep(1)  # soyons polis avec ModDB

        local_date = parse_moddb_date(date_local)
        has_update = bool(local_date and remote_date and remote_date > local_date)

        # Préserver acknowledged_at de l'exécution précédente
        prev = existing.get(folder_name, {})
        acknowledged_at = prev.get("acknowledged_at", None)

        updates.append({
            "id": folder_name,
            "name": name,
            "url": url,
            "date_local": date_local,
            "date_remote": date_remote,
            "has_update": has_update,
            "last_checked": now_iso,
            "acknowledged_at": acknowledged_at
        })

        if has_update:
            print("  → MISE À JOUR : " + (date_local or "?") + " → " + (date_remote or "?"))
        elif remote_date is None:
            print("  → Impossible de récupérer la date distante")
        elif not local_date:
            print("  → Pas de date de référence (moddb_updated vide) — distante : " + (date_remote or "?"))
        else:
            print("  → À jour (" + (date_local or "?") + ")")

    output = {
        "generated": now_iso,
        "updates": updates
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("\nRésultat écrit dans : " + OUTPUT_FILE)
    updates_found = sum(1 for u in updates if u["has_update"])
    print(str(updates_found) + " mise(s) à jour détectée(s) sur " + str(len(updates)) + " mod(s) vérifié(s).")


if __name__ == "__main__":
    main()

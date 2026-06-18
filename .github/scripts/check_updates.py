#!/usr/bin/env python3
"""
Vérifie si les mods de GAMMA extra ont été mis à jour sur ModDB.
Lit les patch.json, scrape les pages ModDB, écrit data/mod_updates.json.
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

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXTRA_DIR = os.path.join(REPO_ROOT, "0. PatchVF", "GAMMA extra")
OUTPUT_FILE = os.path.join(REPO_ROOT, "data", "mod_updates.json")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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


def scrape_moddb_version(url):
    """Retourne la version trouvée sur la page ModDB, ou None si échec."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # Chercher dans le bloc stats de la sidebar ModDB
        # ModDB structure: <h5>Version</h5> suivi d'un <span class="summary">
        for h5 in soup.find_all("h5"):
            if h5.get_text(strip=True).lower() == "version":
                sibling = h5.find_next_sibling()
                if sibling:
                    text = sibling.get_text(strip=True)
                    if text:
                        return text

        # Fallback: tableau de statistiques <dt>/<dd>
        for dt in soup.find_all("dt"):
            if "version" in dt.get_text(strip=True).lower():
                dd = dt.find_next_sibling("dd")
                if dd:
                    text = dd.get_text(strip=True)
                    if text:
                        return text

        # Fallback: méta-données ou balises génériques
        meta = soup.find("meta", {"property": "og:description"})
        if meta:
            content = meta.get("content", "")
            m = re.search(r"[Vv]ersion\s*[:\-]?\s*([\d][^\s,;]{0,20})", content)
            if m:
                return m.group(1).strip()

        print("  [WARN] Version introuvable sur la page : " + url)
        return None
    except Exception as e:
        print("  [WARN] Échec du scraping pour " + url + " : " + str(e))
        return None


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
        version_local = patch.get("version", "")
        name = patch.get("name", folder_name)

        if "moddb.com" not in url:
            print("Ignoré (pas ModDB) : " + name)
            continue

        print("Vérification : " + name + " (" + url + ")")
        version_remote = scrape_moddb_version(url)
        time.sleep(1)  # soyons polis avec ModDB

        has_update = False
        if version_remote is not None:
            has_update = version_remote.strip() != version_local.strip()

        # Préserver acknowledged_at de l'exécution précédente
        prev = existing.get(folder_name, {})
        acknowledged_at = prev.get("acknowledged_at", None)

        updates.append({
            "id": folder_name,
            "name": name,
            "url": url,
            "version_local": version_local,
            "version_remote": version_remote,
            "has_update": has_update,
            "last_checked": now_iso,
            "acknowledged_at": acknowledged_at
        })

        if has_update:
            print("  → MISE À JOUR : " + version_local + " → " + version_remote)
        elif version_remote is None:
            print("  → Impossible de récupérer la version distante")
        else:
            print("  → À jour (" + version_local + ")")

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

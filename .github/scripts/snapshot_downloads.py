#!/usr/bin/env python3
"""
Instantané quotidien des compteurs de téléchargement → data/dl-stats.json.

But : conserver dans le dépôt un historique daté et DURABLE des téléchargements,
qui survit même si le service de comptage public (Abacus) disparaît un jour. Le
site lit en priorité les compteurs en direct ; ce fichier sert de filet de
sécurité et de repli affiché dans l'onglet Admin si Abacus est injoignable.

Caractéristiques :
- Aucune dépendance externe (bibliothèque standard uniquement).
- La base et le namespace sont lus DANS js/app.js (source unique de vérité) : pas
  de risque de désynchronisation si on change DLCOUNT_NS un jour.
- Fenêtre re-vérifiée à chaque exécution (LOOKBACK_DAYS) : les jours déjà écoulés
  ont une valeur figée côté Abacus, donc relire la fenêtre répare automatiquement
  un éventuel trou (exécution manquée) sans jamais écraser l'historique plus ancien.
- Si la lecture du compteur échoue (Abacus HS), le script SORT EN ERREUR sans
  toucher au fichier : le run GitHub passe au rouge (signal direct « Abacus HS »)
  et le dernier bon instantané est préservé.

Découpage des dates au fuseau Europe/Paris (identique au site).
"""

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
APP_JS = ROOT / "js" / "app.js"
OUT = ROOT / "data" / "dl-stats.json"
PARIS = ZoneInfo("Europe/Paris")
LOOKBACK_DAYS = 35   # nombre de jours re-vérifiés à chaque exécution
TIMEOUT = 15         # secondes par requête


def read_consts():
    """Extrait DLCOUNT_BASE / DLCOUNT_NS de js/app.js (source unique de vérité)."""
    src = APP_JS.read_text(encoding="utf-8")
    base = re.search(r'DLCOUNT_BASE\s*=\s*"([^"]+)"', src)
    ns = re.search(r'DLCOUNT_NS\s*=\s*"([^"]+)"', src)
    if not base or not ns:
        sys.exit("DLCOUNT_BASE / DLCOUNT_NS introuvables dans js/app.js.")
    return base.group(1).rstrip("/"), ns.group(1)


def get_counter(base, ns, key):
    """Valeur d'un compteur (lecture seule). 404 = pas encore créé → 0.
    Toute autre erreur (réseau, HTTP) lève une exception → Abacus considéré HS."""
    url = "%s/get/%s/%s" % (base, ns, urllib.parse.quote(key))
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        value = data.get("value")
        return int(value) if isinstance(value, (int, float)) else 0
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return 0
        raise


def load_existing():
    """Instantané existant (préserve l'historique hors fenêtre de relecture)."""
    snap = {"updated": None, "total": 0, "months": {}, "days": {}}
    if OUT.exists():
        try:
            cur = json.loads(OUT.read_text(encoding="utf-8"))
            if isinstance(cur, dict):
                snap["total"] = cur.get("total", 0)
                snap["months"] = dict(cur.get("months", {}))
                snap["days"] = dict(cur.get("days", {}))
        except (ValueError, OSError):
            pass  # fichier illisible → on repart d'un instantané vierge
    return snap


def main():
    base, ns = read_consts()

    # Sonde primaire : si elle échoue, Abacus est HS → on ne modifie rien.
    try:
        total = get_counter(base, ns, "total")
    except Exception as exc:  # noqa: BLE001 (on veut un message clair + code retour ≠ 0)
        sys.exit("Compteur injoignable (Abacus HS ?) : %s" % exc)

    snap = load_existing()
    snap["total"] = total

    today = datetime.now(PARIS).date()
    months_seen = set()
    for i in range(LOOKBACK_DAYS, -1, -1):
        day = (today - timedelta(days=i)).isoformat()  # AAAA-MM-JJ
        months_seen.add(day[:7])                        # AAAA-MM
        value = get_counter(base, ns, "d-" + day)
        if value > 0:
            snap["days"][day] = value
    for month in sorted(months_seen):
        value = get_counter(base, ns, "m-" + month)
        if value > 0:
            snap["months"][month] = value

    snap["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    OUT.write_text(json.dumps(snap, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Instantané écrit : total=%d, jours=%d, mois=%d"
          % (total, len(snap["days"]), len(snap["months"])))


if __name__ == "__main__":
    main()

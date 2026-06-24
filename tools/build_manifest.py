#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Génère data/patches.json à partir de l'arborescence "0. PatchVF/".

Structure attendue :
  0. PatchVF/
    MainFile/                  -> squelette copié tel quel dans le ZIP
    GAMMA base/                -> fichiers FR de base
    GAMMA tweak/<patch>/        -> XML + patch.json
    GAMMA extra/<patch>/        -> XML + patch.json

patch.json (UTF-8) : { "name", "description", "date", "version", "moddb_updated", "url", "priority" }

Usage :
    python3 tools/build_manifest.py            # depuis la racine du dépôt
    python3 tools/build_manifest.py --root .   # racine explicite
"""
import argparse
import datetime
import json
import os
import re
import sys

PATCH_BASE = "0. PatchVF"
SECTIONS = {"base": "GAMMA base", "tweak": "GAMMA tweak", "extra": "GAMMA extra"}
MAINFILE_DIR = "MainFile"
META_NAME = "patch.json"


def rel_posix(path, root):
    """Chemin relatif au dépôt, séparateurs POSIX."""
    return os.path.relpath(path, root).replace(os.sep, "/")


def natural_key(name):
    """Clé de tri « naturelle » : « 9 » < « 10 » < « 90 » < « 200 » (et non
    l'ordre lexicographique où « 200 » précède « 90 »). Découpe la chaîne en
    segments alternant texte / nombre ; les segments numériques sont comparés
    comme des entiers. Le motif garantit que texte et nombre ne se retrouvent
    jamais comparés au même rang (indices pairs = texte, impairs = nombre)."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def list_files(folder, root, skip=()):
    """Tous les fichiers (récursif), triés, en chemins relatifs au dépôt."""
    out = []
    if not os.path.isdir(folder):
        return out
    for dirpath, _dirs, names in os.walk(folder):
        for n in sorted(names):
            if n in skip:
                continue
            out.append(rel_posix(os.path.join(dirpath, n), root))
    return sorted(out)


def read_meta(folder):
    """Lit patch.json (UTF-8) ; valeurs par défaut si absent/illisible."""
    meta = {"name": None, "description": "", "date": "", "version": "", "moddb_updated": "", "url": "", "priority": 0}
    p = os.path.join(folder, META_NAME)
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            for k in meta:
                if k in data and data[k] is not None:
                    meta[k] = data[k]
        except Exception as e:  # noqa: BLE001
            print("  [!] patch.json illisible (%s) : %s" % (p, e), file=sys.stderr)
    try:
        meta["priority"] = int(meta["priority"])
    except (TypeError, ValueError):
        meta["priority"] = 0
    return meta


def build_patch_list(section_dir, root):
    """Une entrée par sous-dossier de tweak/extra."""
    patches = []
    if not os.path.isdir(section_dir):
        return patches
    for name in sorted(os.listdir(section_dir), key=natural_key):
        folder = os.path.join(section_dir, name)
        if not os.path.isdir(folder):
            continue
        meta = read_meta(folder)
        files = list_files(folder, root, skip=(META_NAME,))
        if not files:
            print("  [!] dossier sans fichier ignoré : %s" % folder, file=sys.stderr)
            continue
        patches.append({
            "id": name,
            "name": meta["name"] or name,
            "description": meta["description"],
            "date": meta["date"],
            "version": meta["version"],
            "moddb_updated": meta["moddb_updated"],
            "url": meta["url"],
            "priority": meta["priority"],
            "files": files,
        })
    return patches


def main():
    ap = argparse.ArgumentParser(description="Génère data/patches.json depuis \"0. PatchVF/\".")
    ap.add_argument("--root", default=".", help="Racine du dépôt (défaut : .)")
    ap.add_argument("--out", default=os.path.join("data", "patches.json"), help="Fichier de sortie")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    base_dir = os.path.join(root, PATCH_BASE)
    if not os.path.isdir(base_dir):
        print("Erreur : dossier \"%s\" introuvable sous %s" % (PATCH_BASE, root), file=sys.stderr)
        sys.exit(1)

    manifest = {
        "generated": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat(),
        "base": {"files": list_files(os.path.join(base_dir, SECTIONS["base"]), root)},
        "tweak": build_patch_list(os.path.join(base_dir, SECTIONS["tweak"]), root),
        "extra": build_patch_list(os.path.join(base_dir, SECTIONS["extra"]), root),
        "mainfile": {"files": list_files(os.path.join(base_dir, MAINFILE_DIR), root)},
    }

    out_path = os.path.join(root, args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("OK -> %s" % rel_posix(out_path, root))
    print("  base   : %d fichier(s)" % len(manifest["base"]["files"]))
    print("  tweak  : %d patch(s)" % len(manifest["tweak"]))
    print("  extra  : %d patch(s)" % len(manifest["extra"]))
    print("  mainfile: %d fichier(s)" % len(manifest["mainfile"]["files"]))


if __name__ == "__main__":
    main()

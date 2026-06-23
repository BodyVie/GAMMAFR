"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../js/core.js");

test("baseName renvoie le dernier segment du chemin", () => {
  assert.equal(core.baseName("gamedata/configs/text/fra/st_dialogs.xml"), "st_dialogs.xml");
  assert.equal(core.baseName("st_x.xml"), "st_x.xml");
});

test("cmpVersion compare segment par segment, numériquement", () => {
  assert.ok(core.cmpVersion("1.2.0", "1.10.0") < 0, "1.2 < 1.10 (et non lexicographique)");
  assert.ok(core.cmpVersion("2.0", "1.9.9") > 0);
  assert.equal(core.cmpVersion("1.0", "1.0.0"), 0, "segments manquants = 0");
  assert.equal(core.cmpVersion("", ""), 0);
});

test("cmpNatural trie les nombres numériquement, pas lexicographiquement", () => {
  assert.ok(core.cmpNatural("90", "200") < 0, "90 avant 200 (et non l'inverse lexicographique)");
  assert.ok(core.cmpNatural("9", "10") < 0, "9 avant 10");
  assert.ok(
    core.cmpNatural("94- Tacticool scopes", "208- Ironman Roguelite") < 0,
    "94- … avant 208- … (préfixe numérique comparé comme nombre)"
  );
  assert.equal(core.cmpNatural("", ""), 0);

  const dossiers = ["208- X", "94- Y", "300- Z", "2. A", "10- B"];
  assert.deepEqual(
    dossiers.slice().sort(core.cmpNatural),
    ["2. A", "10- B", "94- Y", "208- X", "300- Z"]
  );
});

test("resolveFiles : la priorité la plus élevée gagne", () => {
  const r = core.resolveFiles([
    { label: "GAMMA base", priority: -Infinity, files: ["base/st_x.xml"] },
    { label: "Patch A", priority: 10, files: ["a/st_x.xml"] },
    { label: "Patch B", priority: 50, files: ["b/st_x.xml"] }
  ]);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].name, "st_x.xml");
  assert.equal(r.files[0].winner.label, "Patch B");
  assert.equal(r.files[0].winner.path, "b/st_x.xml");
  assert.equal(r.files[0].conflict, false);
  assert.equal(r.warnings.length, 0);
});

test("resolveFiles : égalité de priorité => conflit + gagnant déterministe (alphabétique)", () => {
  const r = core.resolveFiles([
    { label: "Zeta", priority: 50, files: ["z/st_x.xml"] },
    { label: "Alpha", priority: 50, files: ["a/st_x.xml"] }
  ]);
  assert.equal(r.files[0].conflict, true);
  assert.equal(r.files[0].winner.label, "Alpha");
  assert.deepEqual(r.warnings, ["st_x.xml"]);
});

test("resolveFiles : fichiers distincts triés par nom, sans conflit", () => {
  const r = core.resolveFiles([
    { label: "P", priority: 1, files: ["x/st_b.xml", "x/st_a.xml"] }
  ]);
  assert.deepEqual(r.files.map((f) => f.name), ["st_a.xml", "st_b.xml"]);
  assert.ok(r.files.every((f) => !f.conflict));
});

test("resolveFiles : base seule conserve la base comme gagnant", () => {
  const r = core.resolveFiles([
    { label: "GAMMA base", priority: -Infinity, files: ["base/st_a.xml"] }
  ]);
  assert.equal(r.files[0].winner.label, "GAMMA base");
});

test("resolveFiles : entrée vide ne casse pas", () => {
  assert.deepEqual(core.resolveFiles([]), { files: [], warnings: [] });
  assert.deepEqual(core.resolveFiles(), { files: [], warnings: [] });
});

test("buildConfigText : en-tête, niveau et sections lisibles", () => {
  const txt = core.buildConfigText(
    "extra",
    [
      { title: "Patchs G.A.M.M.A. tweak", items: ["94- A", "208- B"] },
      { title: "Patchs G.A.M.M.A. extra", items: ["1. C"] }
    ],
    { app: "1.2.3", savedAt: "2026-06-23T00:00:00Z" }
  );
  assert.ok(txt.includes("ModListeConfigurateur"), "contient le marqueur");
  assert.ok(/^#/.test(txt), "commence par un commentaire d'en-tête");
  assert.ok(txt.includes("Niveau = extra"));
  assert.ok(txt.includes("# Version du site : 1.2.3"));
  assert.ok(txt.includes("94- A") && txt.includes("208- B") && txt.includes("1. C"));
});

test("buildConfigText : sections vides omises", () => {
  const txt = core.buildConfigText("tweak", [
    { title: "Patchs G.A.M.M.A. tweak", items: ["94- A"] },
    { title: "Patchs G.A.M.M.A. extra", items: [] }
  ], {});
  assert.ok(txt.includes("# Patchs G.A.M.M.A. tweak"));
  assert.ok(!txt.includes("# Patchs G.A.M.M.A. extra"), "section vide non écrite");
});

test("parseConfigText : restaure la sélection, sépare les introuvables", () => {
  const txt = core.buildConfigText("tweak", [
    { title: "Patchs G.A.M.M.A. tweak", items: ["A", "B", "Z"] }
  ], {});
  const res = core.parseConfigText(txt, (level) => {
    assert.equal(level, "tweak");
    return ["A", "B", "C"];
  });
  assert.equal(res.level, "tweak");
  assert.deepEqual(res.selected, { A: true, B: true });
  assert.deepEqual(res.matched, ["A", "B"]);
  assert.deepEqual(res.missing, ["Z"]); // n'existe plus dans le pack courant
});

test("parseConfigText : tolère le BOM UTF-8, les commentaires et « Niveau: »", () => {
  const txt = "﻿# ModListeConfigurateur\r\nNiveau: EXTRA\r\n# section\r\nA\r\n";
  const res = core.parseConfigText(txt, ["A", "B"]);
  assert.equal(res.level, "extra");
  assert.deepEqual(res.matched, ["A"]);
});

test("parseConfigText : niveau base ignore les patchs", () => {
  const txt = "# ModListeConfigurateur\nNiveau = base\nX\n";
  const res = core.parseConfigText(txt, ["X"]);
  assert.deepEqual(res.selected, {});
  assert.deepEqual(res.missing, []);
});

test("parseConfigText : rejette un fichier non compatible (sans marqueur)", () => {
  assert.throws(() => core.parseConfigText("Niveau = extra\nA\n", ["A"]), /non compatible/i);
  assert.throws(() => core.parseConfigText(42, []), /illisible/i);
});

test("parseConfigText : rejette un niveau manquant ou inconnu", () => {
  assert.throws(() => core.parseConfigText("# ModListeConfigurateur\nA\n", ["A"]), /niveau/i);
  assert.throws(
    () => core.parseConfigText("# ModListeConfigurateur\nNiveau = ultra\n", []),
    /niveau/i
  );
});

test("buildConfigText → parseConfigText : aller-retour conserve la sélection", () => {
  const txt = core.buildConfigText("extra", [
    { title: "Patchs G.A.M.M.A. tweak", items: ["A"] },
    { title: "Patchs G.A.M.M.A. extra", items: ["C"] }
  ], { savedAt: "x" });
  const res = core.parseConfigText(txt, ["A", "B", "C"]);
  assert.equal(res.level, "extra");
  assert.deepEqual(res.selected, { A: true, C: true });
  assert.deepEqual(res.missing, []);
});

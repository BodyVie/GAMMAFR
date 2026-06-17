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

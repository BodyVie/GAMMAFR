"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// worker.js est un module ES → import dynamique depuis ce fichier CommonJS.
// validateSchema renvoie un message d'erreur (string, truthy) ou null si conforme.
const workerP = import("../worker.js");

test("validateSchema : changelog.json = tableau d'objets { version, changes? }", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("changelog.json", [{ version: "1.0.0", changes: ["a"] }]), null);
  assert.equal(validateSchema("changelog.json", [{ version: "1.0.0" }]), null, "changes optionnel");
  assert.ok(validateSchema("changelog.json", {}), "objet refusé (tableau attendu)");
  assert.ok(validateSchema("changelog.json", [{ date: "2026-01-01" }]), "version manquante refusée");
  assert.ok(validateSchema("changelog.json", [{ version: "1.0.0", changes: "x" }]), "changes non-tableau refusé");
});

test("validateSchema : files.json = objet, readme texte si présent", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("files.json", {}), null);
  assert.equal(validateSchema("files.json", { readme: "salut" }), null);
  assert.ok(validateSchema("files.json", []), "tableau refusé");
  assert.ok(validateSchema("files.json", { readme: 123 }), "readme non-texte refusé");
});

test("validateSchema : board.json = objet, title/body/updated textes si présents", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("board.json", {}), null);
  assert.equal(validateSchema("board.json", { title: "Coucou", body: "texte", updated: "2026-06-16" }), null);
  assert.ok(validateSchema("board.json", []), "tableau refusé");
  assert.ok(validateSchema("board.json", { title: 123 }), "title non-texte refusé");
  assert.ok(validateSchema("board.json", { body: 5 }), "body non-texte refusé");
});

test("validateSchema : config.json = objet", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("config.json", { site_title: "X" }), null);
  assert.ok(validateSchema("config.json", []), "tableau refusé");
  assert.ok(validateSchema("config.json", "chaîne"), "chaîne refusée");
});

test("validateSchema : planner.json = objet, categories/labels tableaux si présents", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("planner.json", {}), null);
  assert.equal(validateSchema("planner.json", { labels: [], categories: [] }), null);
  assert.ok(validateSchema("planner.json", []), "tableau refusé");
  assert.ok(validateSchema("planner.json", { categories: {} }), "categories non-tableau refusé");
  assert.ok(validateSchema("planner.json", { labels: "x" }), "labels non-tableau refusé");
});

test("validateSchema : admins.json = tableau de pseudos (texte non vide)", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("admins.json", []), null);
  assert.equal(validateSchema("admins.json", ["Body", "Thundard"]), null);
  assert.ok(validateSchema("admins.json", { pas: "un tableau" }), "objet refusé");
  assert.ok(validateSchema("admins.json", ["ok", 123]), "élément non-texte refusé");
  assert.ok(validateSchema("admins.json", ["ok", "  "]), "pseudo vide refusé");
});

test("validateSchema : fichier hors liste blanche n'est pas contraint (null)", async () => {
  const { validateSchema } = await workerP;
  assert.equal(validateSchema("patches.json", { quoi: "que ce soit" }), null);
});

test("validateSchema : patch.json d'un mod = objet { name requis, champs typés }", async () => {
  const { validateSchema } = await workerP;
  const f = "0. PatchVF/GAMMA extra/dialogues-crus/patch.json";
  assert.equal(validateSchema(f, { name: "Dialogues crus" }), null);
  assert.equal(validateSchema(f, { name: "X", description: "d", date: "2026-06-17", version: "1.0.0", url: "http://a", priority: 50 }), null);
  assert.ok(validateSchema(f, []), "tableau refusé");
  assert.ok(validateSchema(f, { name: "" }), "name vide refusé");
  assert.ok(validateSchema(f, { description: "sans nom" }), "name manquant refusé");
  assert.ok(validateSchema(f, { name: "X", priority: "50" }), "priority non-nombre refusée");
  assert.ok(validateSchema(f, { name: "X", url: 5 }), "url non-texte refusée");
});

test("isAllowedFile : data whitelistés + patch.json de mod, anti-traversée", async () => {
  const { isAllowedFile } = await workerP;
  assert.equal(isAllowedFile("config.json"), true);
  assert.equal(isAllowedFile("0. PatchVF/GAMMA extra/mon-mod/patch.json"), true);
  assert.equal(isAllowedFile("0. PatchVF/GAMMA tweak/mon-mod/patch.json"), true);
  assert.equal(isAllowedFile("secrets.json"), false, "fichier arbitraire refusé");
  assert.equal(isAllowedFile("0. PatchVF/GAMMA extra/mon-mod/autre.json"), false, "autre fichier refusé");
  assert.equal(isAllowedFile("0. PatchVF/GAMMA extra/../patch.json"), false, "segment .. refusé");
  assert.equal(isAllowedFile("0. PatchVF/GAMMA extra/a/b/patch.json"), false, "sous-dossier refusé");
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const GammaZip = require("../js/zip.js");

test("crc32 : vecteur de référence '123456789' = 0xCBF43926", () => {
  const data = new TextEncoder().encode("123456789");
  assert.equal(GammaZip.crc32(data) >>> 0, 0xCBF43926);
});

test("crc32 : chaîne vide = 0", () => {
  assert.equal(GammaZip.crc32(new Uint8Array(0)) >>> 0, 0);
});

test("create : produit un ZIP avec les bonnes signatures et le bon nombre d'entrées", async () => {
  const enc = new TextEncoder();
  const entries = [
    { name: "a.txt", data: enc.encode("hello world") },
    { name: "dir/b.xml", data: enc.encode("<root/>") }
  ];
  const blob = await GammaZip.create(entries);
  const buf = new Uint8Array(await blob.arrayBuffer());

  // local file header en tête : "PK\x03\x04"
  assert.deepEqual(Array.from(buf.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);

  // End Of Central Directory ("PK\x05\x06") présent, avec 2 entrées au total
  const eocd = findEOCD(buf);
  assert.notEqual(eocd, -1, "signature EOCD trouvée");
  const totalEntries = buf[eocd + 10] | (buf[eocd + 11] << 8);
  assert.equal(totalEntries, 2);
});

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

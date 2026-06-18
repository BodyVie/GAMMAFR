/* =========================================================================
   GammaZip — écriture de fichiers ZIP en JavaScript pur, sans dépendance.
   - Conserve les octets bruts tels quels (encodage windows-1252 préservé).
   - Compression deflate via CompressionStream si disponible, sinon "store".
   - Pas de ZIP64 : fichiers individuels < 4 Go (largement suffisant ici).
   Expose : window.GammaZip.create(entries) -> Promise<Blob>
            entries = [{ name: "chemin/dans/zip.xml", data: Uint8Array }]
   ========================================================================= */
(function () {
  "use strict";

  // ---- CRC32 -------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- deflate (optionnel, via l'API navigateur) -------------------------
  function deflateRaw(u8) {
    if (typeof CompressionStream === "undefined") return Promise.resolve(null);
    try {
      var cs = new CompressionStream("deflate-raw");
      var writer = cs.writable.getWriter();
      writer.write(u8);
      writer.close();
      return new Response(cs.readable).arrayBuffer().then(function (ab) {
        return new Uint8Array(ab);
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ---- helpers binaires --------------------------------------------------
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    // repli minimal
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(bytes);
  }

  function dosDateTime(d) {
    d = d || new Date();
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    var date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  function pushU16(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function pushU32(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }

  // ---- construction ------------------------------------------------------
  function create(entries) {
    var dt = dosDateTime(new Date());
    var prepared = new Array(entries.length);

    // 1) préparer chaque entrée (crc + compression) — en parallèle borné.
    //    Plusieurs flux de compression travaillent de front au lieu d'être
    //    enchaînés un à un, ce qui accélère nettement la phase de compression
    //    sur de nombreux fichiers. L'écriture par index conserve l'ordre des
    //    entrées dans l'archive finale (sortie identique à la version série).
    function prepare(i) {
      var entry = entries[i];
      var data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      var crc = crc32(data);
      var nameBytes = utf8Bytes(entry.name);
      return deflateRaw(data).then(function (deflated) {
        var method, stored;
        if (deflated && deflated.length < data.length) { method = 8; stored = deflated; }
        else { method = 0; stored = data; }
        prepared[i] = {
          nameBytes: nameBytes,
          crc: crc,
          method: method,
          comp: stored,
          compSize: stored.length,
          uncompSize: data.length
        };
      });
    }

    var CONCURRENCY = 8, next = 0;
    function worker() {
      if (next >= entries.length) return Promise.resolve();
      var i = next++;
      return prepare(i).then(worker);
    }
    var pool = [];
    for (var w = 0; w < Math.min(CONCURRENCY, entries.length); w++) pool.push(worker());

    // 2) sérialiser local headers + central directory + EOCD
    return Promise.all(pool).then(function () {
      var parts = [];      // Uint8Array chunks
      var offset = 0;      // offset courant
      var central = [];    // octets du central directory
      var SIG_LOCAL = 0x04034b50, SIG_CEN = 0x02014b50, SIG_EOCD = 0x06054b50;
      var FLAG_UTF8 = 0x0800;

      prepared.forEach(function (p) {
        var local = [];
        pushU32(local, SIG_LOCAL);
        pushU16(local, 20);          // version needed
        pushU16(local, FLAG_UTF8);   // general purpose flag (UTF-8 names)
        pushU16(local, p.method);
        pushU16(local, dt.time);
        pushU16(local, dt.date);
        pushU32(local, p.crc);
        pushU32(local, p.compSize);
        pushU32(local, p.uncompSize);
        pushU16(local, p.nameBytes.length);
        pushU16(local, 0);           // extra length
        var localHeader = new Uint8Array(local);

        parts.push(localHeader, p.nameBytes, p.comp);
        var localOffset = offset;
        offset += localHeader.length + p.nameBytes.length + p.comp.length;

        // central directory record
        pushU32(central, SIG_CEN);
        pushU16(central, 20);        // version made by
        pushU16(central, 20);        // version needed
        pushU16(central, FLAG_UTF8);
        pushU16(central, p.method);
        pushU16(central, dt.time);
        pushU16(central, dt.date);
        pushU32(central, p.crc);
        pushU32(central, p.compSize);
        pushU32(central, p.uncompSize);
        pushU16(central, p.nameBytes.length);
        pushU16(central, 0);         // extra length
        pushU16(central, 0);         // comment length
        pushU16(central, 0);         // disk number start
        pushU16(central, 0);         // internal attrs
        pushU32(central, 0);         // external attrs
        pushU32(central, localOffset);
        for (var i = 0; i < p.nameBytes.length; i++) central.push(p.nameBytes[i]);
      });

      var centralBytes = new Uint8Array(central);
      var centralOffset = offset;

      var eocd = [];
      pushU32(eocd, SIG_EOCD);
      pushU16(eocd, 0);                       // disk number
      pushU16(eocd, 0);                       // disk with central dir
      pushU16(eocd, prepared.length);         // entries on this disk
      pushU16(eocd, prepared.length);         // total entries
      pushU32(eocd, centralBytes.length);     // central dir size
      pushU32(eocd, centralOffset);           // central dir offset
      pushU16(eocd, 0);                       // comment length

      parts.push(centralBytes, new Uint8Array(eocd));
      return new Blob(parts, { type: "application/zip" });
    });
  }

  var api = { create: create, crc32: crc32 };
  if (typeof window !== "undefined") window.GammaZip = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

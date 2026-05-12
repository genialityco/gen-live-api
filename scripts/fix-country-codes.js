/**
 * fix-country-codes.js
 *
 * Normaliza los campos `codigo_pais_*` en registrationData de OrgAttendees.
 * Problema: la librería country-state-city devuelve códigos como "+1-809 and 1-829"
 * y el código del front añadía otro "+" encima → "++1-809 and 1-829".
 *
 * Uso (mongosh):
 *   mongosh "mongodb+srv://..." --file scripts/fix-country-codes.js
 *
 * Uso (Node.js con MONGODB_URI en .env):
 *   node scripts/fix-country-codes.js
 */

// ─── Modo Node.js ─────────────────────────────────────────────────────────────
const isNode = typeof require !== "undefined" && typeof db === "undefined";

if (isNode) {
  require("dotenv").config();
  const { MongoClient } = require("mongodb");

  (async () => {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const database = client.db();
      await runMigration(database.collection("orgattendees"));
    } finally {
      await client.close();
    }
  })();
}

// ─── Modo mongosh ─────────────────────────────────────────────────────────────
// Si se ejecuta con mongosh, la variable `db` ya existe globalmente.
if (typeof db !== "undefined") {
  runMigration(db.getCollection("orgattendees"));
}

// ─── Lógica principal ─────────────────────────────────────────────────────────
async function runMigration(collection) {
  function normalizeDialCode(raw) {
    if (!raw || typeof raw !== "string") return raw;
    // Tomar solo el primer código si hay "and" (ej: "1-809 and 1-829" → "1-809")
    const first = raw.split(/\s+and\s+/i)[0].trim();
    // Eliminar todos los "+" iniciales y poner exactamente uno
    const clean = first.replace(/^\++/, "");
    return "+" + clean;
  }

  const cursor = collection.find({});
  let updated = 0;
  let checked = 0;

  const docs = isNode ? await cursor.toArray() : cursor.toArray();

  for (const doc of docs) {
    checked++;
    const rd = doc.registrationData;
    if (!rd || typeof rd !== "object") continue;

    const updates = {};

    for (const key of Object.keys(rd)) {
      const keyLower = key.toLowerCase();
      const isDialCodeField =
        keyLower.includes("codigo") || keyLower.includes("countrycode");

      if (!isDialCodeField) continue;

      const val = rd[key];
      if (typeof val !== "string") continue;

      // Solo corregir si está malformado
      const needsFix = val.startsWith("++") || /\s+and\s+/i.test(val);
      if (!needsFix) continue;

      updates[`registrationData.${key}`] = normalizeDialCode(val);
    }

    if (Object.keys(updates).length === 0) continue;

    if (isNode) {
      await collection.updateOne({ _id: doc._id }, { $set: updates });
    } else {
      collection.updateOne({ _id: doc._id }, { $set: updates });
    }

    updated++;
    const id = doc._id?.toString?.() ?? doc._id;
    const preview = Object.entries(updates)
      .map(([k, v]) => `  ${k}: "${rd[k.replace("registrationData.", "")]}" → "${v}"`)
      .join("\n");
    print(`[${updated}] Documento ${id}\n${preview}`);
  }

  print(`\nRevisados: ${checked} | Actualizados: ${updated}`);
}

function print(msg) {
  if (isNode) {
    console.log(msg);
  } else {
    // mongosh usa print() de forma nativa
    // eslint-disable-next-line no-undef
    globalThis.print?.(msg) ?? console.log(msg);
  }
}

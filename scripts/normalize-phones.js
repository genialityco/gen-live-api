/**
 * normalize-phones.js
 *
 * Separa el código de país del número de teléfono en registrationData de OrgAttendees.
 *
 * Problema: muchos registros tienen el código de país embebido en el campo telefono_*
 * en distintos formatos, en lugar de estar solo en codigo_pais_*:
 *
 *   (+58)04123726174      → código: +58  | teléfono: 04123726174
 *   +573001234567         → código: +57  | teléfono: 3001234567
 *   00573001234567        → código: +57  | teléfono: 3001234567
 *   573001234567          → código: +57  | teléfono: 3001234567  (bare, guiado por codigo_pais)
 *
 * Uso (Node.js):
 *   node scripts/normalize-phones.js                        # Dry-run (solo muestra)
 *   node scripts/normalize-phones.js --apply                # Aplica cambios
 *   node scripts/normalize-phones.js --org <orgId>          # Solo una org
 *   node scripts/normalize-phones.js --org <orgId> --apply  # Org + aplica
 *
 * Uso (mongosh):
 *   mongosh "mongodb+srv://..." --file scripts/normalize-phones.js
 *   (En mongosh siempre aplica — no hay dry-run)
 */

// ─── Modo Node.js ──────────────────────────────────────────────────────────────
const isNode = typeof require !== 'undefined' && typeof db === 'undefined';

if (isNode) {
  require('dotenv').config();
  const { MongoClient, ObjectId } = require('mongodb');

  const DRY_RUN = !process.argv.includes('--apply');
  const orgArgIdx = process.argv.indexOf('--org');
  const TARGET_ORG_ID = orgArgIdx !== -1 ? process.argv[orgArgIdx + 1] : null;

  (async () => {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const database = client.db();
      await runMigration(
        database.collection('organizations'),
        database.collection('orgattendees'),
        { dryRun: DRY_RUN, targetOrgId: TARGET_ORG_ID, ObjectId },
      );
    } finally {
      await client.close();
    }
  })();
}

// ─── Modo mongosh ──────────────────────────────────────────────────────────────
if (typeof db !== 'undefined') {
  runMigration(
    db.getCollection('organizations'),
    db.getCollection('orgattendees'),
    { dryRun: false, targetOrgId: null, ObjectId: null },
  );
}

// ─── Lógica de normalización de códigos ────────────────────────────────────────

/**
 * Códigos de país ordenados de mayor a menor longitud para evitar falsos positivos.
 * Ej: +1787 (Puerto Rico) debe intentarse antes que +1 (USA/Canadá).
 */
const KNOWN_CODES = [
  '1787', '1809', '1829', '1849',               // Caribe NANP
  '593',  '595',  '598',  '591',                // Ecuador, Paraguay, Uruguay, Bolivia
  '502',  '503',  '504',  '505',  '506',  '507', '509', // Centroamérica + Haití
  '57',   '58',   '52',   '54',   '51',   '56', // Colombia, Venezuela, México, Argentina, Perú, Chile
  '55',   '34',   '44',   '49',   '33',   '39', // Brasil, España, UK, Alemania, Francia, Italia
  '1',                                           // USA / Canadá
];

/**
 * Normaliza un código de país crudo al formato +XX.
 * Ejemplos: '57' → '+57', '(+58)' → '+58', '0057' → '+57', '+57' → '+57'
 */
function normalizeCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[() ]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return /^\+\d{1,4}$/.test(s) ? s : null;
  if (s.startsWith('00') && /^\d{3,6}$/.test(s)) return '+' + s.slice(2);
  if (/^\d{1,4}$/.test(s)) return '+' + s;
  return null;
}

/**
 * Intenta detectar un código de país embebido en un número de teléfono.
 *
 * @param {string} rawPhone  - Valor del campo telefono_*
 * @param {string|null} knownCode - Valor normalizado del campo codigo_pais_* (ej: '+57')
 * @returns {{ code: string, local: string, method: string } | null}
 *   - code: el código de país detectado en formato +XX
 *   - local: el número sin el código
 *   - method: descripción del patrón que coincidió
 *   - null si no se detecta ningún código embebido
 */
function extractEmbeddedCode(rawPhone, knownCode) {
  const s = String(rawPhone || '').trim();
  if (!s) return null;

  // ── Patrón 1: prefijo entre paréntesis ── (+58)04123 · (58)04123 · ( +57 ) 3001234567
  const parenMatch = s.match(/^\(\s*\+?(\d{1,4})\s*\)\s*([\s\S]*)$/);
  if (parenMatch) {
    return {
      code: '+' + parenMatch[1],
      local: parenMatch[2].trim(),
      method: 'parens',
    };
  }

  // ── Patrón 2: prefijo con "+" ── +5804123... · +57 3001234567
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/^[\s-]+/, '');
    // Primero intentar con el código ya conocido (más preciso)
    if (knownCode) {
      const c = knownCode.slice(1);
      if (digits.startsWith(c) && digits.length > c.length) {
        return { code: knownCode, local: digits.slice(c.length).trim(), method: '+prefix(known)' };
      }
    }
    // Luego con la lista general
    for (const c of KNOWN_CODES) {
      if (digits.startsWith(c) && digits.length > c.length) {
        return { code: '+' + c, local: digits.slice(c.length).trim(), method: '+prefix(list)' };
      }
    }
  }

  // ── Patrón 3: prefijo "00" ── 005804123... · 0057 3001234567
  if (s.startsWith('00')) {
    const digits = s.slice(2).replace(/^[\s-]+/, '');
    if (knownCode) {
      const c = knownCode.slice(1);
      if (digits.startsWith(c) && digits.length > c.length) {
        return { code: knownCode, local: digits.slice(c.length).trim(), method: '00prefix(known)' };
      }
    }
    for (const c of KNOWN_CODES) {
      if (digits.startsWith(c) && digits.length > c.length) {
        return { code: '+' + c, local: digits.slice(c.length).trim(), method: '00prefix(list)' };
      }
    }
  }

  // ── Patrón 4: dígitos directos sin "+" ni "00" ──
  // Solo se usa cuando se conoce el codigo_pais y el número empieza directamente
  // con los dígitos del código (sin 0 inicial). Ej: '573001234567' con codigo +57.
  if (knownCode && !s.startsWith('0')) {
    const c = knownCode.slice(1);
    // Exige que quede al menos 5 dígitos de número local para evitar falsos positivos
    if (s.startsWith(c) && s.length > c.length + 4) {
      return { code: knownCode, local: s.slice(c.length).trim(), method: 'bare(known)' };
    }
  }

  return null;
}

// ─── Migración principal ───────────────────────────────────────────────────────

async function runMigration(orgsCollection, attendeesCollection, opts) {
  const { dryRun, targetOrgId, ObjectId } = opts;

  print('\n' + (dryRun
    ? '🔍  DRY-RUN — solo lectura. Usa --apply para guardar cambios.'
    : '✏️   APPLY  — los cambios se escribirán en MongoDB.'));
  print('═'.repeat(60));

  // Filtro de org(s) a procesar
  const orgFilter = targetOrgId
    ? { _id: ObjectId ? new ObjectId(targetOrgId) : targetOrgId }
    : {};

  const orgs = isNode
    ? await orgsCollection.find(orgFilter).toArray()
    : orgsCollection.find(orgFilter).toArray();

  let totalOrgsProcessed = 0;
  let totalChecked      = 0;
  let totalToChange     = 0;
  let totalApplied      = 0;
  const unresolved      = [];

  for (const org of orgs) {
    const fields = org.registrationForm?.fields ?? [];

    // Buscar los campos código de país y teléfono por prefijo de ID
    const codigoField   = fields.find(f => typeof f.id === 'string' && f.id.startsWith('codigo_pais_'));
    const telefonoField = fields.find(f => typeof f.id === 'string' && f.id.startsWith('telefono_'));

    if (!codigoField || !telefonoField) continue;

    const codigoId   = codigoField.id;   // ej: "codigo_pais_1779373833813"
    const telefonoId = telefonoField.id; // ej: "telefono_1779373833813"

    print(`\n📋 Org: "${org.name}"  (${org._id})`);
    print(`   codigo_pais → ${codigoId}`);
    print(`   telefono    → ${telefonoId}`);

    // Buscar asistentes que tengan el campo teléfono con algún valor
    const attendeeQuery = {
      $or: [
        { organizationId: org._id.toString() },
        { organizationId: org._id },
      ],
      [`registrationData.${telefonoId}`]: { $exists: true, $type: 'string', $nin: ['', null] },
    };

    const attendees = isNode
      ? await attendeesCollection.find(attendeeQuery).toArray()
      : attendeesCollection.find(attendeeQuery).toArray();

    print(`   Asistentes con teléfono: ${attendees.length}`);
    if (attendees.length === 0) continue;

    totalOrgsProcessed++;

    const ops         = [];
    let orgChanged    = 0;
    let orgSkipped    = 0;
    let orgUnresolved = 0;

    for (const att of attendees) {
      totalChecked++;
      const data     = att.registrationData ?? {};
      const rawPhone = String(data[telefonoId] ?? '').trim();
      const rawCode  = data[codigoId];

      if (!rawPhone) { orgSkipped++; continue; }

      const knownCode = normalizeCode(rawCode);
      const extraction = extractEmbeddedCode(rawPhone, knownCode);

      // ¿El campo codigo_pais necesita re-formato? (ej: '57' → '+57')
      const codeNeedsNormalize = knownCode && knownCode !== rawCode;
      const phoneHasEmbeddedCode = !!extraction;

      if (!phoneHasEmbeddedCode && !codeNeedsNormalize) {
        orgSkipped++;
        continue; // Ya está limpio
      }

      // Si hay extracción, validar que el local resultante tiene sentido
      if (phoneHasEmbeddedCode && (!extraction.local || extraction.local.replace(/\D/g, '').length < 4)) {
        print(`   ⚠️  ${att.email ?? att._id}: resultado sospechoso — local="${extraction.local}" — OMITIDO`);
        unresolved.push({ org: org.name, id: att._id, email: att.email, rawPhone, rawCode });
        orgUnresolved++;
        continue;
      }

      // Construir el update
      const setFields = {};
      const finalCode = extraction?.code ?? knownCode;

      if (phoneHasEmbeddedCode) {
        setFields[`registrationData.${telefonoId}`] = extraction.local;
      }
      if (finalCode && finalCode !== rawCode) {
        setFields[`registrationData.${codigoId}`] = finalCode;
      }

      if (Object.keys(setFields).length === 0) { orgSkipped++; continue; }

      // Log del cambio
      const phoneLog = phoneHasEmbeddedCode
        ? `"${rawPhone}"  →  "${extraction.local}"  [${extraction.method}]`
        : '(sin cambio)';
      const codeLog  = finalCode !== rawCode
        ? `"${rawCode ?? '(vacío)'}"  →  "${finalCode}"`
        : '(sin cambio)';

      print(`   ✓ ${att.email ?? att._id}`);
      print(`       código:   ${codeLog}`);
      print(`       teléfono: ${phoneLog}`);

      ops.push({ updateOne: { filter: { _id: att._id }, update: { $set: setFields } } });
      orgChanged++;
      totalToChange++;
    }

    print(`   ──`);
    print(`   A modificar: ${orgChanged}  |  Sin cambio: ${orgSkipped}  |  No resueltos: ${orgUnresolved}`);

    if (!dryRun && ops.length > 0) {
      const result = isNode
        ? await attendeesCollection.bulkWrite(ops, { ordered: false })
        : attendeesCollection.bulkWrite(ops, { ordered: false });
      const modified = result.modifiedCount ?? result.nModified ?? ops.length;
      totalApplied += modified;
      print(`   ✅ Guardados: ${modified} registros`);
    }
  }

  // ── Resumen final ────────────────────────────────────────────────────────
  print('\n' + '═'.repeat(60));
  print('RESUMEN');
  print(`  Orgs con campos de teléfono: ${totalOrgsProcessed}`);
  print(`  Asistentes revisados:        ${totalChecked}`);
  print(`  Registros a modificar:       ${totalToChange}`);
  if (!dryRun) {
    print(`  Registros guardados:         ${totalApplied}`);
  }

  if (unresolved.length > 0) {
    print(`\n⚠️  No resueltos (${unresolved.length}) — revisar manualmente:`);
    for (const u of unresolved) {
      print(`   ${u.org} | ${u.email ?? u.id} | código="${u.rawCode}" | teléfono="${u.rawPhone}"`);
    }
  }

  if (dryRun) {
    print('\n💡 Para aplicar:  node scripts/normalize-phones.js --apply');
    print('   Solo una org:  node scripts/normalize-phones.js --org <orgId> --apply');
  }
}

function print(msg) {
  if (isNode) {
    console.log(msg);
  } else {
    // eslint-disable-next-line no-undef
    globalThis.print?.(msg) ?? console.log(msg);
  }
}

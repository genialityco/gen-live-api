/**
 * fix-negative-phones.js
 *
 * Corrige los teléfonos que quedaron con un "-" pegado al inicio tras
 * normalize-phones.js (ej: "+57-3115702715" → código "+57" / teléfono "-3115702715").
 *
 * Quita cualquier separador sobrante (espacios, guiones, puntos) del
 * inicio del campo telefono_*, dejando solo dígitos. Si tras limpiar no
 * queda ningún dígito (ej: el valor era literalmente "-"), el registro
 * se omite — no es un caso causado por la migración.
 *
 * Uso (Node.js):
 *   node scripts/fix-negative-phones.js                        # Dry-run (solo muestra)
 *   node scripts/fix-negative-phones.js --apply                # Aplica cambios
 *   node scripts/fix-negative-phones.js --org <orgId>          # Solo una org
 *   node scripts/fix-negative-phones.js --org <orgId> --apply  # Org + aplica
 *
 * Uso (mongosh):
 *   mongosh "mongodb+srv://..." --file scripts/fix-negative-phones.js
 *   (En mongosh siempre aplica — no hay dry-run)
 */

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
      await runFix(
        database.collection('organizations'),
        database.collection('orgattendees'),
        { dryRun: DRY_RUN, targetOrgId: TARGET_ORG_ID, ObjectId },
      );
    } finally {
      await client.close();
    }
  })();
}

if (typeof db !== 'undefined') {
  runFix(
    db.getCollection('organizations'),
    db.getCollection('orgattendees'),
    { dryRun: false, targetOrgId: null, ObjectId: null },
  );
}

async function runFix(orgsCollection, attendeesCollection, opts) {
  const { dryRun, targetOrgId, ObjectId } = opts;

  print('\n' + (dryRun
    ? '🔍  DRY-RUN — solo lectura. Usa --apply para guardar cambios.'
    : '✏️   APPLY  — los cambios se escribirán en MongoDB.'));
  print('═'.repeat(60));

  const orgFilter = targetOrgId
    ? { _id: ObjectId ? new ObjectId(targetOrgId) : targetOrgId }
    : {};

  const orgs = isNode
    ? await orgsCollection.find(orgFilter).toArray()
    : orgsCollection.find(orgFilter).toArray();

  let totalChecked = 0;
  let totalToChange = 0;
  let totalApplied = 0;
  const skipped = [];

  for (const org of orgs) {
    const fields = org.registrationForm?.fields ?? [];
    const telefonoField = fields.find(f => typeof f.id === 'string' && f.id.startsWith('telefono_'));
    if (!telefonoField) continue;

    const telefonoId = telefonoField.id;

    const attendeeQuery = {
      $or: [
        { organizationId: org._id.toString() },
        { organizationId: org._id },
      ],
      [`registrationData.${telefonoId}`]: { $regex: '^[\\s\\-.]' },
    };

    const attendees = isNode
      ? await attendeesCollection.find(attendeeQuery).toArray()
      : attendeesCollection.find(attendeeQuery).toArray();

    if (attendees.length === 0) continue;

    print(`\n📋 Org: "${org.name}"  (${org._id})  campo ${telefonoId}`);

    const ops = [];
    for (const att of attendees) {
      totalChecked++;
      const rawPhone = String(att.registrationData[telefonoId] ?? '');
      const cleaned = rawPhone.trim().replace(/^[\s\-.]+/, '');

      if (!cleaned) {
        print(`   ⚠️  ${att.email ?? att._id}: "${rawPhone}" → vacío tras limpiar — OMITIDO`);
        skipped.push({ org: org.name, id: att._id, email: att.email, rawPhone });
        continue;
      }

      if (cleaned === rawPhone) continue; // ya está limpio

      print(`   ✓ ${att.email ?? att._id}: "${rawPhone}" → "${cleaned}"`);
      ops.push({
        updateOne: {
          filter: { _id: att._id },
          update: { $set: { [`registrationData.${telefonoId}`]: cleaned } },
        },
      });
      totalToChange++;
    }

    if (!dryRun && ops.length > 0) {
      const result = isNode
        ? await attendeesCollection.bulkWrite(ops, { ordered: false })
        : attendeesCollection.bulkWrite(ops, { ordered: false });
      const modified = result.modifiedCount ?? result.nModified ?? ops.length;
      totalApplied += modified;
      print(`   ✅ Guardados: ${modified} registros`);
    }
  }

  print('\n' + '═'.repeat(60));
  print('RESUMEN');
  print(`  Registros revisados:    ${totalChecked}`);
  print(`  Registros a corregir:   ${totalToChange}`);
  if (!dryRun) {
    print(`  Registros guardados:    ${totalApplied}`);
  }

  if (skipped.length > 0) {
    print(`\n⚠️  Omitidos (${skipped.length}) — valor sin dígitos, no es del bug:`);
    for (const s of skipped) {
      print(`   ${s.org} | ${s.email ?? s.id} | telefono="${s.rawPhone}"`);
    }
  }

  if (dryRun) {
    print('\n💡 Para aplicar:  node scripts/fix-negative-phones.js --apply');
    print('   Solo una org:  node scripts/fix-negative-phones.js --org <orgId> --apply');
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

/**
 * cleanup-unregistered-attendees.js
 *
 * Elimina los OrgAttendees de una organización que NO están vinculados
 * a un evento específico (ni inscritos, ni asistentes, ni diferidos):
 *
 *   - No tienen el eventId en su campo `eventIds`
 *   - No tienen un EventUser para ese eventId
 *   - No tienen ViewingSession para ese eventId
 *
 * Útil para limpiar registros importados por una migración masiva que
 * nunca se inscribieron al evento real de la organización.
 *
 * Uso:
 *   node scripts/cleanup-unregistered-attendees.js --org <orgId> --event <eventId>            # Dry-run
 *   node scripts/cleanup-unregistered-attendees.js --org <orgId> --event <eventId> --apply    # Aplica
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const DRY_RUN = !process.argv.includes('--apply');
const orgArgIdx = process.argv.indexOf('--org');
const eventArgIdx = process.argv.indexOf('--event');
const ORG_ID = orgArgIdx !== -1 ? process.argv[orgArgIdx + 1] : null;
const EVENT_ID = eventArgIdx !== -1 ? process.argv[eventArgIdx + 1] : null;

if (!ORG_ID || !EVENT_ID) {
  console.error('Uso: node scripts/cleanup-unregistered-attendees.js --org <orgId> --event <eventId> [--apply]');
  process.exit(1);
}

(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db();

    const orgFilter = {
      $or: [{ organizationId: ORG_ID }, { organizationId: new ObjectId(ORG_ID) }],
    };

    const total = await db.collection('orgattendees').countDocuments(orgFilter);

    const toKeep = await db.collection('orgattendees').countDocuments({
      ...orgFilter,
      eventIds: { $in: [EVENT_ID] },
    });

    const deleteFilter = {
      ...orgFilter,
      eventIds: { $nin: [EVENT_ID] },
    };

    const toDeleteCount = await db.collection('orgattendees').countDocuments(deleteFilter);

    // Verificación cruzada: nadie con EventUser/ViewingSession para este evento
    // debe estar entre los candidatos a borrar.
    const toDeleteIds = await db
      .collection('orgattendees')
      .find(deleteFilter)
      .project({ _id: 1 })
      .toArray();
    const idSet = toDeleteIds.map((d) => d._id);

    const eventUserOverlap = await db.collection('eventusers').countDocuments({
      eventId: EVENT_ID,
      attendeeId: { $in: idSet },
    });
    const overlappingEventUserIds = await db
      .collection('eventusers')
      .find({ eventId: EVENT_ID, attendeeId: { $in: idSet } })
      .project({ _id: 1 })
      .toArray();
    const viewingSessionOverlap = await db.collection('viewingsessions').countDocuments({
      eventId: EVENT_ID,
      eventUserId: { $in: overlappingEventUserIds.map((d) => d._id) },
    });

    console.log('\n' + (DRY_RUN
      ? '🔍  DRY-RUN — solo lectura. Usa --apply para borrar.'
      : '🗑️   APPLY  — los registros se eliminarán de MongoDB.'));
    console.log('═'.repeat(60));
    console.log(`Org: ${ORG_ID}`);
    console.log(`Evento: ${EVENT_ID}`);
    console.log(`Total orgattendees: ${total}`);
    console.log(`A conservar (inscritos/asistentes/diferidos en este evento): ${toKeep}`);
    console.log(`A eliminar (sin vínculo con este evento): ${toDeleteCount}`);

    if (eventUserOverlap > 0 || viewingSessionOverlap > 0) {
      console.error(`\n❌ ABORTADO: ${eventUserOverlap} candidatos a borrar tienen EventUser y ${viewingSessionOverlap} tienen ViewingSession para este evento.`);
      console.error('   Esto no debería pasar — revisa antes de continuar.');
      process.exit(1);
    }
    console.log('✅ Verificación cruzada OK: ningún candidato a borrar tiene EventUser/ViewingSession para este evento.');

    if (!DRY_RUN) {
      const result = await db.collection('orgattendees').deleteMany(deleteFilter);
      console.log(`\n✅ Eliminados: ${result.deletedCount} registros`);
    } else {
      console.log('\n💡 Para aplicar: node scripts/cleanup-unregistered-attendees.js --org ' + ORG_ID + ' --event ' + EVENT_ID + ' --apply');
    }
  } finally {
    await client.close();
  }
})();

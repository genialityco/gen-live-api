
/**
 * Script de Testing Simple - Multiconexión sin Firebase Admin SDK
 * 
 * Este script usa solo HTTP REST APIs para simular usuarios.
 * No requiere Firebase Admin SDK instalado.
 * 
 * Uso:
 *   node test-multiconnection-simple.js --event-id=YOUR_EVENT_ID --users=10
 * 
 * Variables de entorno:
 *   API_URL=http://localhost:8080
 *   FIREBASE_WEB_API_KEY=your-web-api-key
 *   FIREBASE_DATABASE_URL=https://your-project.firebaseio.com
 */

const axios = require('axios');

// ============================================
// CONFIGURACIÓN
// ============================================

const API_URL = process.env.API_URL || 'http://localhost:8080';
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const EVENT_ID = process.argv.find(arg => arg.startsWith('--event-id='))?.split('=')[1];
const NUM_USERS = parseInt(process.argv.find(arg => arg.startsWith('--users='))?.split('=')[1] || '10');
const DURATION_MINUTES = parseInt(process.argv.find(arg => arg.startsWith('--duration='))?.split('=')[1] || '3');

// ============================================
// VALIDACIONES
// ============================================

if (!EVENT_ID) {
  console.error('❌ Error: --event-id es requerido');
  console.log('\nUso: node test-multiconnection-simple.js --event-id=YOUR_EVENT_ID --users=10\n');
  process.exit(1);
}

if (!FIREBASE_WEB_API_KEY) {
  console.error('❌ Error: FIREBASE_WEB_API_KEY no configurada');
  console.log('Configura: export FIREBASE_WEB_API_KEY=your-key\n');
  process.exit(1);
}

if (!FIREBASE_DATABASE_URL) {
  console.error('❌ Error: FIREBASE_DATABASE_URL no configurada');
  console.log('Configura: export FIREBASE_DATABASE_URL=https://your-project.firebaseio.com\n');
  process.exit(1);
}

console.log(`
╔════════════════════════════════════════════════════════════╗
║     TEST DE MULTICONEXIÓN (Usuarios Anónimos 🚀)          ║
╚════════════════════════════════════════════════════════════╝

📋 Configuración:
   API URL:       ${API_URL}
   Event ID:      ${EVENT_ID}
   Usuarios:      ${NUM_USERS} (anónimos)
   Duración:      ${DURATION_MINUTES} minutos
   
💡 Usando autenticación anónima de Firebase = Sin rate limits
`);

// ============================================
// UTILIDADES
// ============================================

const stats = {
  created: 0,
  registered: 0,
  connected: 0,
  heartbeats: 0,
  errors: 0,
};

function randomString(length = 8) {
  return Math.random().toString(36).substring(2, length + 2);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// FIREBASE REST API
// ============================================

async function createFirebaseUser(retries = 3) {
  // Usar autenticación ANÓNIMA - mucho más rápido y sin rate limits estrictos
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB_API_KEY}`,
        { returnSecureToken: true } // Sin email/password = usuario anónimo
      );
      
      // Generar email único para el registro del evento
      const email = `anonymous-${response.data.localId}@test.local`;
      
      return {
        uid: response.data.localId,
        idToken: response.data.idToken,
        email,
      };
    } catch (error) {
      if (attempt === retries) throw error;
      
      // Exponential backoff más agresivo para evitar bloqueos
      const waitTime = 2000 * Math.pow(2, attempt - 1);
      console.log(`⚠️  Firebase error - reintentando en ${waitTime}ms (${attempt}/${retries})...`);
      await sleep(waitTime);
    }
  }
}

async function registerToEvent(firebaseUID, email, retries = 3) {
  const name = `Test User ${randomString(4)}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        `${API_URL}/events/${EVENT_ID}/register`,
        {
          email,
          firebaseUID,
          formData: { name, email },
        },
        { timeout: 10000 } // 10 segundos timeout
      );
      
      return response.data;
    } catch (error) {
      if (attempt === retries) throw error;
      
      const waitTime = 1000 * Math.pow(2, attempt - 1);
      console.log(`⚠️  Register failed - reintentando en ${waitTime}ms (${attempt}/${retries})...`);
      await sleep(waitTime);
    }
  }
}

async function writePresence(firebaseUID, idToken) {
  // Escribir presencia usando Firebase REST API
  const url = `${FIREBASE_DATABASE_URL}/presence/${EVENT_ID}/${firebaseUID}.json?auth=${idToken}`;
  
  await axios.put(url, {
    on: true,
    ts: Date.now(),
  });
}

async function removePresence(firebaseUID, idToken) {
  const url = `${FIREBASE_DATABASE_URL}/presence/${EVENT_ID}/${firebaseUID}.json?auth=${idToken}`;
  await axios.delete(url);
}

// ============================================
// SIMULADOR DE USUARIO
// ============================================

class SimpleUser {
  constructor(id) {
    this.id = id;
    this.uid = null;
    this.idToken = null;
    this.email = null;
    this.interval = null;
    this.heartbeatCount = 0;
  }

  async setup() {
    try {
      // Crear usuario en Firebase
      const user = await createFirebaseUser();
      this.uid = user.uid;
      this.idToken = user.idToken;
      this.email = user.email;
      stats.created++;
      
      console.log(`✓ [${this.id}] Created: ${this.email.substring(0, 30)}...`);
      
      // Registrar al evento
      await registerToEvent(this.uid, this.email);
      stats.registered++;
      
      console.log(`✓ [${this.id}] Registered to event`);
      
      return true;
    } catch (error) {
      console.error(`✗ [${this.id}] Setup error: ${error.message}`);
      stats.errors++;
      return false;
    }
  }

  async connect() {
    try {
      // Escribir presencia inicial
      await writePresence(this.uid, this.idToken);
      stats.connected++;
      
      // Iniciar heartbeats cada 15 segundos
      this.interval = setInterval(async () => {
        try {
          await writePresence(this.uid, this.idToken);
          this.heartbeatCount++;
          stats.heartbeats++;
        } catch (error) {
          console.error(`⚠ [${this.id}] Heartbeat error: ${error.message}`);
        }
      }, 15000);
      
      console.log(`🟢 [${this.id}] Connected and sending heartbeats`);
      return true;
    } catch (error) {
      console.error(`✗ [${this.id}] Connect error: ${error.message}`);
      stats.errors++;
      return false;
    }
  }

  async disconnect() {
    if (this.interval) {
      clearInterval(this.interval);
    }
    
    try {
      await removePresence(this.uid, this.idToken);
      console.log(`🔴 [${this.id}] Disconnected (${this.heartbeatCount} heartbeats)`);
    } catch (error) {
      console.error(`✗ [${this.id}] Disconnect error: ${error.message}`);
    }
  }
}

// ============================================
// EJECUTAR TEST
// ============================================

async function runTest() {
  const users = [];
  const startTime = Date.now();
  
  try {
    console.log(`\n📦 Fase 1: Creando ${NUM_USERS} usuarios ANÓNIMOS...\n`);
    
    // Configuración conservadora para evitar bloqueos de Firebase
    const BATCH_SIZE = NUM_USERS > 100 ? 10 : 5;
    const DELAY_BETWEEN_USERS = NUM_USERS > 100 ? 500 : 800; // Más lento para evitar rate limits
    const DELAY_BETWEEN_BATCHES = NUM_USERS > 100 ? 5000 : 3000; // Pausas largas entre batches
    
    // Crear usuarios en batches
    for (let i = 0; i < NUM_USERS; i++) {
      const user = new SimpleUser(i + 1);
      users.push(user);
      
      const setupSuccess = await user.setup();
      
      if (setupSuccess) {
        await user.connect();
      }
      
      // Delay entre usuarios
      await sleep(DELAY_BETWEEN_USERS);
      
      // Pausa más larga cada batch para dar respiro a Firebase
      if ((i + 1) % BATCH_SIZE === 0) {
        const progress = Math.floor(((i + 1) / NUM_USERS) * 100);
        console.log(`\n⏸️  Batch ${Math.floor((i + 1) / BATCH_SIZE)}/${Math.ceil(NUM_USERS / BATCH_SIZE)} completo (${progress}%) - Pausa de ${DELAY_BETWEEN_BATCHES}ms...\n`);
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }
    
    console.log(`\n✅ Setup completo: ${stats.connected}/${NUM_USERS} usuarios conectados\n`);
    
    console.log(`📊 Monitoreando durante ${DURATION_MINUTES} minutos...\n`);
    
    // Monitoreo con progreso
    const totalSeconds = DURATION_MINUTES * 60;
    for (let i = 0; i < totalSeconds; i++) {
      const remaining = totalSeconds - i;
      const progress = Math.floor((i / totalSeconds) * 100);
      
      process.stdout.write(`\r⏱️  [${progress}%] Tiempo restante: ${remaining}s | Heartbeats: ${stats.heartbeats} | Errores: ${stats.errors}`);
      
      await sleep(1000);
    }
    
    console.log(`\n\n🔌 Desconectando usuarios...\n`);
    
    // Desconectar todos
    for (const user of users) {
      if (user.uid) {
        await user.disconnect();
        await sleep(200);
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                  TEST COMPLETADO ✓                         ║
╠════════════════════════════════════════════════════════════╣
║  Duración:               ${totalTime} minutos                       ║
║  Usuarios creados:       ${stats.created}/${NUM_USERS}                                ║
║  Usuarios registrados:   ${stats.registered}/${NUM_USERS}                                ║
║  Usuarios conectados:    ${stats.connected}/${NUM_USERS}                                ║
║  Total heartbeats:       ${stats.heartbeats}                               ║
║  Errores:                ${stats.errors}                                  ║
╚════════════════════════════════════════════════════════════╝

💡 Próximos pasos:
   1. Verifica las métricas del evento:
      GET ${API_URL}/api/events/${EVENT_ID}/metrics

   2. Revisa el health check:
      GET ${API_URL}/api/events/debug/health

   3. Revisa los logs del backend para warnings

👋 Test finalizado!
`);
    
  } catch (error) {
    console.error(`\n❌ Error fatal: ${error.message}\n`);
    console.error(error.stack);
  } finally {
    // Limpiar todos los usuarios
    for (const user of users) {
      if (user.uid && user.interval) {
        clearInterval(user.interval);
        try {
          await removePresence(user.uid, user.idToken);
        } catch (e) {
          // Ignorar errores de cleanup
        }
      }
    }
  }
  
  process.exit(0);
}

// Ejecutar
runTest();

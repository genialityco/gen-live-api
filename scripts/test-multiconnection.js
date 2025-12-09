/**
 * Script de Testing - Multiconexión de Usuarios a Evento
 * 
 * Simula múltiples usuarios registrándose, haciendo login y conectándose
 * a un evento simultáneamente para probar el sistema de métricas.
 * 
 * Uso:
 *   node test-multiconnection.js --event-id=YOUR_EVENT_ID --users=50
 * 
 * Variables de entorno requeridas:
 *   API_URL=http://localhost:8080  (o tu URL de API)
 *   FIREBASE_WEB_API_KEY=your-key   (para autenticación)
 */

const axios = require('axios');
const admin = require('firebase-admin');

// ============================================
// CONFIGURACIÓN
// ============================================

const API_URL = process.env.API_URL || 'http://localhost:8080';
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const EVENT_ID = process.argv.find(arg => arg.startsWith('--event-id='))?.split('=')[1];
const NUM_USERS = parseInt(process.argv.find(arg => arg.startsWith('--users='))?.split('=')[1] || '10');
const DURATION_MINUTES = parseInt(process.argv.find(arg => arg.startsWith('--duration='))?.split('=')[1] || '5');
const HEARTBEAT_INTERVAL = 15000; // 15 segundos

// Colores para la consola
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

// ============================================
// VALIDACIONES
// ============================================

if (!EVENT_ID) {
  console.error(`${colors.red}❌ Error: --event-id es requerido${colors.reset}`);
  console.log('\nUso: node test-multiconnection.js --event-id=YOUR_EVENT_ID --users=50 --duration=5\n');
  process.exit(1);
}

if (!FIREBASE_WEB_API_KEY) {
  console.error(`${colors.red}❌ Error: FIREBASE_WEB_API_KEY no configurada${colors.reset}`);
  console.log('\nConfigura: export FIREBASE_WEB_API_KEY=your-web-api-key\n');
  process.exit(1);
}

console.log(`${colors.cyan}
╔════════════════════════════════════════════════════════════╗
║        TEST DE MULTICONEXIÓN - SISTEMA DE MÉTRICAS        ║
╚════════════════════════════════════════════════════════════╝
${colors.reset}`);

console.log(`${colors.blue}📋 Configuración:${colors.reset}`);
console.log(`   API URL:       ${API_URL}`);
console.log(`   Event ID:      ${EVENT_ID}`);
console.log(`   Usuarios:      ${NUM_USERS}`);
console.log(`   Duración:      ${DURATION_MINUTES} minutos`);
console.log(`   Heartbeat:     ${HEARTBEAT_INTERVAL}ms\n`);

// ============================================
// UTILIDADES
// ============================================

function randomEmail() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `test-user-${timestamp}-${random}@loadtest.local`;
}

function randomName() {
  const firstNames = ['Juan', 'María', 'Pedro', 'Ana', 'Carlos', 'Laura', 'Diego', 'Sofia'];
  const lastNames = ['García', 'Rodríguez', 'Martínez', 'López', 'González', 'Pérez', 'Sánchez'];
  return `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// FUNCIONES DE API
// ============================================

/**
 * Crear usuario anónimo en Firebase Auth
 */
async function createFirebaseUser(email, password) {
  try {
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB_API_KEY}`,
      {
        email,
        password,
        returnSecureToken: true,
      }
    );
    return {
      uid: response.data.localId,
      idToken: response.data.idToken,
      email: response.data.email,
    };
  } catch (error) {
    throw new Error(`Firebase signup failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Login con Firebase
 */
async function loginFirebaseUser(email, password) {
  try {
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      {
        email,
        password,
        returnSecureToken: true,
      }
    );
    return {
      uid: response.data.localId,
      idToken: response.data.idToken,
      email: response.data.email,
    };
  } catch (error) {
    throw new Error(`Firebase login failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Registrar usuario al evento
 */
async function registerToEvent(eventId, firebaseUID, email, name) {
  try {
    const response = await axios.post(
      `${API_URL}/events/${eventId}/register`,
      {
        email,
        firebaseUID,
        formData: {
          name,
          email,
        },
      }
    );
    return response.data;
  } catch (error) {
    throw new Error(`Event registration failed: ${error.response?.data?.message || error.message}`);
  }
}

/**
 * Escribir presencia en Firebase RTDB
 */
async function writePresence(eventId, firebaseUID) {
  try {
    await admin.database()
      .ref(`/presence/${eventId}/${firebaseUID}`)
      .set({
        on: true,
        ts: admin.database.ServerValue.TIMESTAMP,
      });
  } catch (error) {
    throw new Error(`Write presence failed: ${error.message}`);
  }
}

/**
 * Eliminar presencia de Firebase RTDB
 */
async function removePresence(eventId, firebaseUID) {
  try {
    await admin.database()
      .ref(`/presence/${eventId}/${firebaseUID}`)
      .remove();
  } catch (error) {
    console.error(`Remove presence failed: ${error.message}`);
  }
}

/**
 * Obtener métricas del evento
 */
async function getEventMetrics(eventId, idToken) {
  try {
    const response = await axios.get(
      `${API_URL}/events/${eventId}/metrics`,
      {
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    // Es normal que falle si el usuario no es owner
    return null;
  }
}

// ============================================
// SIMULADOR DE USUARIO
// ============================================

class UserSimulator {
  constructor(id) {
    this.id = id;
    this.email = randomEmail();
    this.password = 'Test123456!';
    this.name = randomName();
    this.firebaseUID = null;
    this.idToken = null;
    this.heartbeatInterval = null;
    this.isActive = false;
    this.heartbeatCount = 0;
  }

  async setup() {
    try {
      // 1. Crear usuario en Firebase
      console.log(`${colors.blue}[User ${this.id}]${colors.reset} Creating Firebase user: ${this.email}`);
      const firebaseUser = await createFirebaseUser(this.email, this.password);
      this.firebaseUID = firebaseUser.uid;
      this.idToken = firebaseUser.idToken;

      // 2. Registrar al evento
      console.log(`${colors.blue}[User ${this.id}]${colors.reset} Registering to event...`);
      await registerToEvent(EVENT_ID, this.firebaseUID, this.email, this.name);

      console.log(`${colors.green}✓ [User ${this.id}]${colors.reset} Setup complete: ${this.name}`);
      return true;
    } catch (error) {
      console.error(`${colors.red}✗ [User ${this.id}]${colors.reset} Setup failed: ${error.message}`);
      return false;
    }
  }

  async connect() {
    try {
      // Escribir presencia inicial
      await writePresence(EVENT_ID, this.firebaseUID);
      this.isActive = true;
      
      // Iniciar heartbeats
      this.heartbeatInterval = setInterval(async () => {
        if (this.isActive) {
          await this.sendHeartbeat();
        }
      }, HEARTBEAT_INTERVAL);

      console.log(`${colors.green}🟢 [User ${this.id}]${colors.reset} Connected and sending heartbeats`);
      return true;
    } catch (error) {
      console.error(`${colors.red}✗ [User ${this.id}]${colors.reset} Connection failed: ${error.message}`);
      return false;
    }
  }

  async sendHeartbeat() {
    try {
      await writePresence(EVENT_ID, this.firebaseUID);
      this.heartbeatCount++;
      
      if (this.heartbeatCount % 4 === 0) { // Log cada minuto (4 heartbeats)
        console.log(`${colors.cyan}💓 [User ${this.id}]${colors.reset} Heartbeat #${this.heartbeatCount}`);
      }
    } catch (error) {
      console.error(`${colors.yellow}⚠ [User ${this.id}]${colors.reset} Heartbeat failed: ${error.message}`);
    }
  }

  async disconnect() {
    this.isActive = false;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    try {
      await removePresence(EVENT_ID, this.firebaseUID);
      console.log(`${colors.yellow}🔴 [User ${this.id}]${colors.reset} Disconnected (${this.heartbeatCount} heartbeats sent)`);
    } catch (error) {
      console.error(`${colors.red}✗ [User ${this.id}]${colors.reset} Disconnect failed: ${error.message}`);
    }
  }
}

// ============================================
// MONITOR DE MÉTRICAS
// ============================================

class MetricsMonitor {
  constructor() {
    this.interval = null;
    this.history = [];
  }

  start(ownerIdToken) {
    this.interval = setInterval(async () => {
      const metrics = await getEventMetrics(EVENT_ID, ownerIdToken);
      
      if (metrics) {
        this.history.push({
          timestamp: new Date().toISOString(),
          ...metrics,
        });

        console.log(`${colors.cyan}
╔════════════════════════════════════════════╗
║           MÉTRICAS EN TIEMPO REAL          ║
╠════════════════════════════════════════════╣
║  Concurrentes:   ${String(metrics.currentConcurrentViewers || 0).padEnd(25)}║
║  Pico máximo:    ${String(metrics.peakConcurrentViewers || 0).padEnd(25)}║
║  Total únicos:   ${String(metrics.totalUniqueViewers || 0).padEnd(25)}║
╚════════════════════════════════════════════╝
${colors.reset}`);
      }
    }, 10000); // Cada 10 segundos
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  getSummary() {
    if (this.history.length === 0) return null;

    const maxConcurrent = Math.max(...this.history.map(h => h.currentConcurrentViewers || 0));
    const maxPeak = Math.max(...this.history.map(h => h.peakConcurrentViewers || 0));
    const maxUnique = Math.max(...this.history.map(h => h.totalUniqueViewers || 0));

    return {
      maxConcurrent,
      maxPeak,
      maxUnique,
      samples: this.history.length,
    };
  }
}

// ============================================
// MAIN - EJECUTAR TEST
// ============================================

async function runTest() {
  const startTime = Date.now();
  const users = [];
  const monitor = new MetricsMonitor();

  try {
    // Paso 1: Crear y configurar usuarios
    console.log(`\n${colors.yellow}📦 Fase 1: Creando ${NUM_USERS} usuarios...${colors.reset}\n`);
    
    for (let i = 0; i < NUM_USERS; i++) {
      const user = new UserSimulator(i + 1);
      users.push(user);
    }

    // Setup en paralelo (grupos de 5 para no sobrecargar)
    const BATCH_SIZE = 5;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(user => user.setup()));
      await sleep(1000); // 1 segundo entre batches
    }

    const successfulUsers = users.filter(u => u.firebaseUID !== null);
    console.log(`\n${colors.green}✓ ${successfulUsers.length}/${NUM_USERS} usuarios configurados exitosamente${colors.reset}\n`);

    if (successfulUsers.length === 0) {
      throw new Error('No se pudo configurar ningún usuario');
    }

    // Paso 2: Conectar todos simultáneamente
    console.log(`${colors.yellow}🚀 Fase 2: Conectando ${successfulUsers.length} usuarios simultáneamente...${colors.reset}\n`);
    
    await Promise.all(successfulUsers.map(user => user.connect()));
    await sleep(2000); // Esperar 2 segundos para que se procesen las conexiones

    // Paso 3: Iniciar monitoreo
    console.log(`${colors.yellow}📊 Fase 3: Monitoreando métricas durante ${DURATION_MINUTES} minutos...${colors.reset}\n`);
    
    // Usar el token del primer usuario para monitorear (puede fallar si no es owner)
    monitor.start(successfulUsers[0]?.idToken);

    // Paso 4: Mantener conexiones activas
    const endTime = Date.now() + (DURATION_MINUTES * 60 * 1000);
    
    while (Date.now() < endTime) {
      const remaining = Math.ceil((endTime - Date.now()) / 1000);
      process.stdout.write(`\r${colors.blue}⏱️  Tiempo restante: ${remaining}s${colors.reset}`);
      await sleep(1000);
    }

    console.log(`\n\n${colors.yellow}🔌 Fase 4: Desconectando usuarios...${colors.reset}\n`);

    // Desconectar todos
    await Promise.all(successfulUsers.map(user => user.disconnect()));
    await sleep(2000);

    // Detener monitor
    monitor.stop();

    // Resumen final
    const summary = monitor.getSummary();
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

    console.log(`${colors.green}
╔════════════════════════════════════════════════════════════╗
║                  TEST COMPLETADO ✓                         ║
╠════════════════════════════════════════════════════════════╣
║  Duración total:         ${totalTime} minutos                       ║
║  Usuarios configurados:  ${successfulUsers.length}/${NUM_USERS}                               ║
║  Heartbeats por usuario: ~${Math.floor(DURATION_MINUTES * 60 / (HEARTBEAT_INTERVAL / 1000))}                                  ║
${summary ? `║                                                            ║
║  MÉTRICAS MÁXIMAS OBSERVADAS:                              ║
║  - Concurrentes:         ${summary.maxConcurrent}                                  ║
║  - Pico máximo:          ${summary.maxPeak}                                  ║
║  - Total únicos:         ${summary.maxUnique}                                  ║` : ''}
╚════════════════════════════════════════════════════════════╝
${colors.reset}`);

    console.log(`\n${colors.cyan}💡 Recomendaciones:${colors.reset}`);
    console.log(`   1. Revisa los logs del backend para verificar que no hay warnings excesivos`);
    console.log(`   2. Verifica el health check: GET ${API_URL}/api/events/debug/health`);
    console.log(`   3. Monitorea el uso de memoria del proceso backend\n`);

  } catch (error) {
    console.error(`\n${colors.red}❌ Error durante el test: ${error.message}${colors.reset}\n`);
    console.error(error.stack);
  } finally {
    // Asegurar que todos los usuarios se desconecten
    for (const user of users) {
      if (user.isActive) {
        await user.disconnect();
      }
    }
    
    monitor.stop();
    
    // Dar tiempo para cleanup
    await sleep(2000);
    
    console.log(`${colors.yellow}👋 Test finalizado. Bye!${colors.reset}\n`);
    process.exit(0);
  }
}

// Ejecutar
runTest().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});

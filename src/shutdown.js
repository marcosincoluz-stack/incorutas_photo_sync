const { logger } = require('./utils/logger');
const { jobQueue } = require('./jobs/bull-queue');
const { metricsStore } = require('./utils/metrics-store');
const { stopPolling } = require('./jobs/polling');
const { stopDiskMonitor } = require('./index');
const notify = require('./utils/notify');
const config = require('./config');
const fs = require('fs');
const path = require('path');

const HTTP_DRAIN_GRACE_MS = 2000;
const FORCE_EXIT_TIMEOUT_MS = 35000;
const GRACEFUL_SHUTDOWN_FILE = path.join(__dirname, '../data/.last_graceful_shutdown');
let isShuttingDown = false;
const startTime = Date.now();

/**
 * Manejo graceful de señales SIGTERM/SIGINT.
 * Cierra el servidor HTTP, espera a que los jobs activos terminen,
 * cierra conexiones de Redis y persiste métricas.
 */
function handleGracefulShutdown(signal, server) {
  if (isShuttingDown) {
    logger.warn(`Señal ${signal} recibida de nuevo. Cierre ya en progreso.`);
    return;
  }
  isShuttingDown = true;

  logger.info(`\x1b[33m⏻ Señal ${signal} recibida. Iniciando cierre graceful...\x1b[0m`);

  server.close(() => {
    logger.info('Servidor HTTP cerrado. No se aceptan nuevas peticiones.');
  });

  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      logger.info('Forzando cierre de conexiones HTTP keep-alive...');
      server.closeAllConnections();
    }
  }, HTTP_DRAIN_GRACE_MS);

  shutdownResources();

  setTimeout(() => {
    logger.error('💀 Forzando apagado por timeout.');
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
}

async function shutdownResources() {
  try {
    stopPolling();
  } catch (err) {
    logger.error('Error deteniendo polling:', err.message);
  }

  try {
    stopDiskMonitor();
  } catch (err) {
    logger.error('Error deteniendo disk monitor:', err.message);
  }

  let checks = 0;
  const maxChecks = 30;

  try {
    let queueStatus = await jobQueue.getStatus();

    while (queueStatus.isProcessing && checks < maxChecks) {
      logger.info(`⏳ Esperando fin de tarea activa... (${checks + 1}/${maxChecks}s)`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      queueStatus = await jobQueue.getStatus();
      checks++;
    }

    if (queueStatus.isProcessing) {
      logger.warn('⚠️  Timeout de espera agotado. Cerrando con tareas activas.');
    } else {
      logger.info('✔ Cola finalizada limpiamente.');
    }
  } catch (err) {
    logger.error('Error consultando estado de cola durante shutdown:', err.message);
  }

  try {
    await jobQueue.shutdown();
  } catch (err) {
    logger.error('Error durante el cierre de la cola BullMQ:', err);
  }

  try {
    metricsStore.shutdown();
  } catch (err) {
    logger.error('Error durante el cierre de MetricsStore:', err);
  }

  // Escribir marcador de apagado graceful ANTES de Telegram (si Telegram se cuelga, el marcador queda)
  try {
    const dataDir = path.dirname(GRACEFUL_SHUTDOWN_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(GRACEFUL_SHUTDOWN_FILE, Date.now().toString(), 'utf8');
  } catch (err) {
    logger.error('Error escribiendo archivo de shutdown:', err.message);
  }

  // Enviar notificación de apagado a Telegram (no bloqueante para el marcador)
  if (config.HAS_TELEGRAM) {
    try {
      const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      await notify.notifyShutdown('SIGTERM', uptimeSeconds);
    } catch (err) {
      logger.error('Error enviando notificación de apagado a Telegram:', err.message);
    }
  }

  logger.info('👋 Proceso finalizado.');
  process.exit(0);
}

module.exports = { handleGracefulShutdown };

// @ts-check
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { supabase } = require('./supabase');
const { logger } = require('../utils/logger');
const sharp = require('sharp');
// Limitar la caché interna de sharp para no acumular memoria entre descargas (exif strip)
// (guardado: en tests sharp puede estar mockeado sin .cache)
if (typeof sharp.cache === 'function') {
  sharp.cache({ memory: 16, files: 0, items: 20 });
}
const { sanitizeFilename, ensurePathWithinBase } = require('../utils/sanitize');
const { isAllowedEvidenceExtension, validateFileContent } = require('../utils/image-validator');
const { checkDiskSpace } = require('../utils/disk');
const { createLockProvider } = require('../utils/lock');
const { metricsTracker } = require('../jobs/metrics-tracker');
const { getRedisConnection } = require('../utils/redis-connection');

/**
 * @typedef {Object} EvidenceRecord
 * @property {string} id - UUID de la evidencia en Supabase
 * @property {string} url - URL o path del archivo en el bucket de Storage
 * @property {'photo'|'signature'} type - Tipo de evidencia
 */

/**
 * @typedef {Object} DownloadResult
 * @property {number} [downloaded] - Fotos descargadas con éxito
 * @property {number} [skipped] - Fotos omitidas (ya existían)
 * @property {number} [errors] - Fotos con error (dentro de tolerancia)
 * @property {boolean} [skipped] - Si true, el job fue omitido
 * @property {string} [reason] - Motivo del skip ('already_downloaded'|'lock_contention'|'job_not_found'|'job_deleted'|'max_reached'|'no_folder'|'no_pdf'|'up_to_date')
 */

/**
 * @typedef {Object} RetryResult
 * @property {number} retried - Total de evidencias reintentadas
 * @property {number} succeeded - Reintentos exitosos
 * @property {number} stillFailed - Reintentos que siguen fallando
 */

const lockProvider = (function createProvider() {
  if (config.LOCK_PROVIDER === 'redis') {
    return createLockProvider('redis', getRedisConnection());
  }
  return createLockProvider('memory');
})();

const SUPABASE_QUERY_TIMEOUT_MS = 10000;

function withTimeout(promise, ms = SUPABASE_QUERY_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout consultando Supabase tras ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Extrae la ruta de almacenamiento relativa dentro del bucket a partir de una URL de Supabase Storage
 * o devuelve la misma ruta si ya es relativa.
 * 
 * @param {string} urlOrPath URL completa o path relativo
 * @returns {string} Path limpio dentro del bucket
 */
function getStoragePath(urlOrPath) {
  if (!urlOrPath) return '';
  const bucket = config.SUPABASE_BUCKET;
  if (urlOrPath.includes('/storage/v1/object/')) {
    const parts = urlOrPath.split(`/${bucket}/`);
    if (parts.length > 1) {
      return parts[1].split('?')[0];
    }
  }
  return urlOrPath.split('?')[0];
}

const MAX_UNIQUE_ATTEMPTS = 100;

/**
 * Resuelve un nombre de archivo único dentro de una carpeta.
 * Si el archivo ya existe, añade sufijo (1), (2), etc. antes de la extensión.
 * No crea el archivo — la atomicidad la garantiza el rename .part → dest en downloadFileWithRetry.
 *
 * @param {string} targetFolder Carpeta destino
 * @param {string} filename Nombre base del archivo
 * @returns {Promise<string>} Ruta absoluta única
 */
async function resolveUniqueFilename(targetFolder, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(targetFolder, filename);

  for (let i = 1; i <= MAX_UNIQUE_ATTEMPTS; i++) {
    try {
      await fs.promises.access(candidate);
      candidate = path.join(targetFolder, `${base} (${i})${ext}`);
    } catch {
      return candidate;
    }
  }

  throw new Error(`Demasiadas colisiones de nombre para "${filename}" tras ${MAX_UNIQUE_ATTEMPTS} intentos`);
}

const MAX_WALK_DEPTH = 50;

/**
 * Limpia archivos .part huérfanos dejados por descargas interrumpidas.
 * Recorre 1ACTIVOS recursivamente eliminando cualquier *.part.
 *
 * @returns {Promise<number>} Número de archivos limpiados
 */
async function cleanupOrphanedPartFiles() {
  const activosPath = path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS');
  let cleaned = 0;

  async function walk(dirPath, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      logger.debug(`[Cleanup] No se pudo leer directorio "${dirPath}": ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.part')) {
        try {
          await fs.promises.unlink(fullPath);
          cleaned++;
          logger.info(`[Cleanup] Eliminado .part huérfano: "${fullPath}"`);
        } catch (err) {
          logger.debug(`[Cleanup] No se pudo eliminar .part huérfano "${fullPath}": ${err.message}`);
        }
      }
    }
  }

  try {
    await walk(activosPath, 0);
    if (cleaned > 0) {
      logger.info(`[Cleanup] ${cleaned} archivos .part huérfanos eliminados.`);
    }
  } catch (err) {
    logger.warn(`[Cleanup] No se pudo escanear 1ACTIVOS: ${err.message}`);
  }

  return cleaned;
}

const EXCLUDED_DIR_NAMES = new Set([
  'FOTOS', 'DOCUMENTACION', 'CALCULOS', 'FABRICACION',
  'CORREOS', 'ORIGINALES', 'PROPUESTAS', 'FOTOS ANTES',
  'FOTOS TERMINADO', 'TERMINADOS', '1ACTIVOS', '1TRABAJOS'
]);

/**
 * Determina si una carpeta debe ser escaneada recursivamente en busca de proyectos.
 * Evita entrar a carpetas de proyecto (empiezan por P) y subcarpetas internas estándar.
 *
 * @param {string} name Nombre del directorio
 * @returns {boolean} true si se debe escanear, false en caso contrario
 */
function shouldScanDirectory(name) {
  if (name.match(/^P\d+/i)) return false;
  if (EXCLUDED_DIR_NAMES.has(name.toUpperCase())) return false;
  return true;
}

/**
 * Busca recursivamente una carpeta que empiece por el código del proyecto.
 * Para optimizar la velocidad en red (SMB/CIFS), busca hasta 4 niveles de profundidad
 * y omite escanear dentro de otras carpetas de proyecto (que empiezan por 'P') o subcarpetas internas.
 *
 * @param {string} dir Directorio base donde buscar (ej: 1ACTIVOS)
 * @param {string} projectCode Código del proyecto (ej: P251967)
 * @param {number} currentDepth Profundidad actual
 * @param {number} maxDepth Profundidad máxima
 * @returns {Promise<string|null>} Ruta absoluta de la carpeta del proyecto o null
 */
async function findProjectFolderRecursive(dir, projectCode, currentDepth = 0, maxDepth = 4) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    // 1. Buscar coincidencia directa en el nivel actual
    const match = entries.find(d => d.isDirectory() && d.name.toUpperCase().startsWith(projectCode));
    if (match) {
      return path.join(dir, match.name);
    }

    // 2. Si no se superó la profundidad máxima, buscar en subcarpetas (usando la poda)
    if (currentDepth < maxDepth) {
      const subdirs = entries.filter(d => d.isDirectory() && shouldScanDirectory(d.name));
      for (const subdir of subdirs) {
        const foundPath = await findProjectFolderRecursive(
          path.join(dir, subdir.name),
          projectCode,
          currentDepth + 1,
          maxDepth
        );
        if (foundPath) return foundPath;
      }
    }
  } catch (err) {
    logger.warn(`[ResolveFolder] Error escaneando "${dir}" para buscar ${projectCode}: ${err.message}`);
  }
  return null;
}

/**
 * Busca o crea la carpeta del proyecto en 1ACTIVOS basándose en el código del proyecto (ej: P260251).
 * 
 * @param {string} jobTitle Título del trabajo
 * @returns {Promise<string>} Ruta absoluta de la carpeta 'FOTOS/FOTOS TERMINADO'
 */
async function resolveProjectPhotosFolder(jobTitle) {
  const trimmedTitle = jobTitle.trim();
  const match = trimmedTitle.match(/^(P\d+)/i);
  
  if (!match) {
    throw new Error(`El título del trabajo "${trimmedTitle}" no comienza con un código de proyecto válido (Pxxxxx)`);
  }
  
  const projectCode = match[1].toUpperCase();
  const activosPath = path.join(config.TRABAJOS_BASE_PATH, '1ACTIVOS');

  await lockProvider.acquire(projectCode, 30000);
  try {
    await fs.promises.mkdir(activosPath, { recursive: true });

    let finalPhotosPath = null;
    const foundPath = await findProjectFolderRecursive(activosPath, projectCode, 0, 4);

    if (foundPath) {
      logger.info(`[ResolveFolder] Encontrada carpeta de proyecto existente en: "${foundPath}"`);
      finalPhotosPath = path.join(foundPath, 'FOTOS', 'FOTOS TERMINADO');
    } else {
      const remainingTitle = trimmedTitle.replace(/^(P\d+)\s*[-\s]*\s*/i, '');
      const cleanTitle = sanitizeFilename(remainingTitle);
      const folderName = `${projectCode} - ${cleanTitle}`;
      
      const newDirPath = path.join(activosPath, folderName);
      logger.info(`No se encontró carpeta para proyecto ${projectCode}. Creando: "${newDirPath}"`);
      await fs.promises.mkdir(newDirPath, { recursive: true });
      finalPhotosPath = path.join(newDirPath, 'FOTOS', 'FOTOS TERMINADO');
    }

    await fs.promises.mkdir(finalPhotosPath, { recursive: true });

    return ensurePathWithinBase(finalPhotosPath, config.TRABAJOS_BASE_PATH);
  } finally {
    await lockProvider.release(projectCode);
  }
}

/**
 * Descarga un archivo desde el bucket de Supabase con reintentos y retroceso lineal.
 * 
 * @param {string} storagePath Ruta del archivo en el bucket
 * @param {string} destFilePath Ruta local de destino
 */
async function downloadFileWithRetry(storagePath, destFilePath) {
  const maxRetries = config.DOWNLOAD_MAX_RETRIES;
  const baseDelay = config.DOWNLOAD_RETRY_DELAY_MS;
  const partPath = `${destFilePath}.part`;
  let attempt = 0;

  if (maxRetries < 1) {
    throw new Error(`DOWNLOAD_MAX_RETRIES debe ser >= 1 (actual: ${maxRetries})`);
  }

  await fs.promises.unlink(partPath).catch(() => {});

  while (attempt < maxRetries) {
    attempt++;
    try {
      logger.debug(`Descargando de Storage: "${config.SUPABASE_BUCKET}/${storagePath}" (Intento ${attempt}/${maxRetries})`);

      const { data, error } = await supabase.storage
        .from(config.SUPABASE_BUCKET)
        .download(storagePath);

      if (error) throw error;
      if (!data) throw new Error('Supabase Storage devolvió un buffer vacío.');

      const buffer = Buffer.from(await data.arrayBuffer());

      validateFileContent(buffer, destFilePath);

      let finalBuffer = buffer;
      const ext = path.extname(destFilePath).toLowerCase();
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.tiff'];

      if (config.STRIP_EXIF_ENABLED && imageExtensions.includes(ext)) {
        try {
          logger.debug(`[RGPD] Sanitizando metadatos EXIF de la imagen: "${path.basename(destFilePath)}"`);
          finalBuffer = await sharp(buffer).rotate().toBuffer();
        } catch (sharpError) {
          logger.warn(`[RGPD] No se pudo procesar la imagen con sharp para limpiar EXIF: ${sharpError.message}. Guardando buffer original.`);
        }
      }

      await fs.promises.writeFile(partPath, finalBuffer);

      const stat = await fs.promises.stat(partPath);
      if (stat.size === 0) {
        throw new Error('El archivo guardado localmente ocupa 0 bytes (corrupto).');
      }

      const maxFileSizeBytes = config.MAX_FILE_SIZE_MB * 1024 * 1024;
      if (stat.size > maxFileSizeBytes) {
        throw new Error(`El archivo "${path.basename(destFilePath)}" excede el límite de ${config.MAX_FILE_SIZE_MB} MB (${(stat.size / 1024 / 1024).toFixed(2)} MB).`);
      }

      await fs.promises.rename(partPath, destFilePath);

      logger.info(`Descargado con éxito: "${path.basename(destFilePath)}" (${(stat.size / 1024).toFixed(1)} KB)`);
      return { size: stat.size };
    } catch (err) {
      await fs.promises.unlink(partPath).catch(() => {});
      logger.error(`Error en intento ${attempt} de descarga de "${storagePath}": ${err.message}`);

      if (attempt >= maxRetries) {
        throw new Error(`Fallo tras ${maxRetries} intentos de descarga: ${err.message}`);
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      logger.info(`Esperando ${delay}ms antes del reintento...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Actualiza la ruta local del archivo en la base de datos de Supabase.
 * @param {string} evidenceId ID de la evidencia
 * @param {string} localPath Ruta local del archivo descargado
 * @returns {Promise<void>}
 */
async function updateEvidenceLocalPath(evidenceId, localPath) {
  try {
    const { error } = await supabase
      .from('evidence')
      .update({ local_path: localPath })
      .eq('id', evidenceId);

    if (error) throw error;
    logger.debug(`local_path actualizado en BD para evidencia ${evidenceId}`);
    return true;
  } catch (err) {
    logger.error(`Error al actualizar local_path de evidencia ${evidenceId} en la base de datos:`, err.message);
    return false;
  }
}

/**
 * Registra en el Job la fecha y hora de la descarga completada.
 * @param {string} jobId ID del trabajo
 * @returns {Promise<void>}
 */
async function markJobAsDownloaded(jobId) {
  const { error } = await supabase
    .from('jobs')
    .update({ downloaded_at: new Date().toISOString() })
    .eq('id', jobId);

  if (error) {
    throw new Error(`Error al marcar el job como descargado en BD: ${error.message}`);
  }
  logger.info(`Job ${jobId} marcado como descargado correctamente en Supabase.`);
}

/**
 * Procesa la descarga de evidencias de un Job aprobado.
 * 
 * @param {string} jobId ID del trabajo
 * @param {string} jobTitle Título del trabajo
 */
async function processJobApproved(jobId, jobTitle) {
  logger.info(`[Downloader] Iniciando procesamiento de Job ${jobId} ("${jobTitle}")`);

  const jobLockKey = `job:${jobId}`;
  try {
    await lockProvider.acquire(jobLockKey, 120000);
  } catch (err) {
    logger.info(`[Downloader] Job ${jobId} ya está siendo procesado por otra instancia (${err.message}). Omitiendo.`);
    return { skipped: true, reason: 'lock_contention' };
  }

  try {
    return await _processJobApprovedInternal(jobId, jobTitle);
  } finally {
    await lockProvider.release(jobLockKey);
  }
}

async function _processJobApprovedInternal(jobId, jobTitle) {
  logger.info(`[Downloader] Iniciando procesamiento de Job ${jobId} ("${jobTitle}")`);

  // 1. Comprobar Idempotencia: Verificar si ya ha sido descargado previamente
  try {
    const { data: job, error: jobError } = await withTimeout(
      supabase
        .from('jobs')
        .select('downloaded_at, title')
        .eq('id', jobId)
        .single()
    );

    if (jobError) throw jobError;
    if (!job) throw new Error('El Job no existe en la base de datos.');

    if (job.downloaded_at) {
      logger.info(`[Downloader] El Job ${jobId} ("${job.title}") ya fue descargado previamente (${job.downloaded_at}). Omitiendo.`);
      return { skipped: true, reason: 'already_downloaded' };
    }
  } catch (err) {
    logger.error(`[Downloader] Error al comprobar idempotencia del Job ${jobId}: ${err.message}`);
    throw err;
  }

  // 2. Comprobar espacio en disco
  const disk = await checkDiskSpace();
  if (!disk.isSafe) {
    throw new Error(`[Downloader] Abortando descarga por falta de espacio en disco. Libre: ${disk.freeMB.toFixed(2)} MB`);
  }

  // 3. Consultar evidencias de tipo 'photo' y 'signature' (actas) en la BD
  let evidences = [];
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('evidence')
        .select('id, url, type')
        .eq('job_id', jobId)
        .in('type', ['photo', 'signature'])
        .is('local_path', null)
        .limit(config.MAX_EVIDENCES_PER_JOB)
    );

    if (error) throw error;
    evidences = data || [];
  } catch (err) {
    logger.error(`[Downloader] Error al consultar evidencias en Supabase para Job ${jobId}:`, err.message);
    throw err;
  }

  if (evidences.length === 0) {
    logger.info(`[Downloader] El Job ${jobId} no contiene fotos de evidencia registradas. Marcando como descargado.`);
    await markJobAsDownloaded(jobId);
    return { downloaded: 0, skipped: 0 };
  }

  // 4. Resolver ruta local de destino en 1ACTIVOS
  let targetFolder = null;
  try {
    targetFolder = await resolveProjectPhotosFolder(jobTitle);
    logger.info(`[Downloader] Ruta destino resuelta: "${targetFolder}"`);
  } catch (err) {
    logger.error(`[Downloader] Error resolviendo ruta destino para Job ${jobId}:`, err.message);
    throw err;
  }

  // 5. Descargar cada foto secuencialmente
  let downloadedCount = 0;
  const skippedCount = 0;
  let errorCount = 0;
  let dbFailures = 0;
  let rejectedCount = 0;

  for (const ev of evidences) {
    const storagePath = getStoragePath(ev.url);
    if (!storagePath) {
      logger.error(`[Downloader] Evidencia ${ev.id} tiene un formato de url inválido: "${ev.url}"`);
      errorCount++;
      continue;
    }

    if (downloadedCount > 0 && downloadedCount % config.DISK_CHECK_INTERVAL === 0) {
      try {
        const disk = await checkDiskSpace();
        if (!disk.isSafe) {
          throw new Error(`Disco lleno durante descarga. Libre: ${disk.freeMB.toFixed(2)} MB`);
        }
      } catch (err) {
        if (err.message.includes('Disco lleno')) {
          logger.error(`[Downloader] Disco lleno durante descarga de Job ${jobId}: ${err.message}`);
          errorCount++;
          break;
        }
        logger.warn(`[Downloader] Disk check mid-loop falló para Job ${jobId} (no fatal): ${err.message}`);
      }
    }

    const originalFilename = path.basename(storagePath);
    const safeFilename = sanitizeFilename(originalFilename);

    if (!isAllowedEvidenceExtension(safeFilename)) {
      logger.warn(`[Downloader] Evidencia ${ev.id} rechazada: extensión no permitida ("${safeFilename}"). Solo se aceptan imágenes y PDFs.`);
      errorCount++;
      rejectedCount++;
      continue;
    }

    const destFilePath = await resolveUniqueFilename(targetFolder, safeFilename);

    try {
      ensurePathWithinBase(destFilePath, targetFolder);

      await downloadFileWithRetry(storagePath, destFilePath);
      const dbOk = await updateEvidenceLocalPath(ev.id, destFilePath);
      if (dbOk) {
        downloadedCount++;
      } else {
        dbFailures++;
        errorCount++;
      }
    } catch (err) {
      logger.error(`[Downloader] Error descargando evidencia ${ev.id} (${storagePath}):`, err.message);
      errorCount++;
    }
  }

  logger.info(`[Downloader] Resumen de descargas para Job ${jobId}: Exitosas: ${downloadedCount}, Omitidas: ${skippedCount}, Errores: ${errorCount}, DB failures: ${dbFailures}`);

  // 6. Marcar el job como descargado según tolerancia
  const tolerance = Math.ceil(evidences.length * (config.DOWNLOAD_TOLERANCE_PERCENT / 100));

  if (rejectedCount > 0) {
    metricsTracker.addRejectedByExtension(rejectedCount);
  }

  if (errorCount === 0) {
    await markJobAsDownloaded(jobId);
    metricsTracker.addPhotos(downloadedCount);
    return { downloaded: downloadedCount, skipped: skippedCount };
  } else if (errorCount <= tolerance) {
    if (dbFailures > 0) {
      logger.warn(`[Downloader] Job ${jobId}: ${dbFailures} fallos de BD al registrar local_path. No se marcará como descargado. El polling re-procesará las fotos pendientes.`);
      throw new Error(`${dbFailures} fotos no se pudieron registrar en la base de datos (local_path). Reintento pendiente.`);
    }
    logger.warn(`[Downloader] Job ${jobId}: ${errorCount} fotos fallidas dentro de tolerancia (${tolerance}). Marcando como descargado con advertencias.`);
    await markJobAsDownloaded(jobId);
    metricsTracker.addPhotos(downloadedCount);
    return { downloaded: downloadedCount, skipped: skippedCount, errors: errorCount };
  } else {
    logger.warn(`[Downloader] Sincronización del Job ${jobId} incompleta: ${errorCount} fotos fallidas de ${evidences.length} (tolerancia: ${tolerance}). No se marcará como descargado.`);
    throw new Error(`Sincronización incompleta: ${errorCount} fotos fallidas de un total de ${evidences.length}`);
  }
}

/**
 * Reintenta la descarga de evidencias fallidas para un job ya descargado.
 *
 * Solo procesa evidences con local_path IS NULL (fotos que fallaron previamente).
 * NO modifica downloaded_at ni crea jobs en BullMQ — es idempotente y manual.
 *
 * @param {string} jobId ID del trabajo (debe tener downloaded_at seteado)
 * @returns {Promise<{retried: number, succeeded: number, stillFailed: number}>}
 */
async function retryFailedEvidences(jobId) {
  logger.info(`[RetryFailed] Iniciando reintento de fotos fallidas para Job ${jobId}`);

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('id, title, downloaded_at')
    .eq('id', jobId)
    .single();

  if (jobError) throw jobError;
  if (!job) throw new Error(`El Job ${jobId} no existe en la base de datos.`);
  if (!job.downloaded_at) {
    throw new Error(`El Job ${jobId} no ha sido descargado previamente. Use processJobApproved en su lugar.`);
  }

  const { data: failedEvidences, error: evError } = await supabase
    .from('evidence')
    .select('id, url, type')
    .eq('job_id', jobId)
    .in('type', ['photo', 'signature'])
    .is('local_path', null)
    .limit(config.MAX_EVIDENCES_PER_JOB);

  if (evError) throw evError;

  if (!failedEvidences || failedEvidences.length === 0) {
    logger.info(`[RetryFailed] No hay fotos fallidas para el Job ${jobId}`);
    return { retried: 0, succeeded: 0, stillFailed: 0 };
  }

  logger.info(`[RetryFailed] Se encontraron ${failedEvidences.length} fotos fallidas para el Job ${jobId}`);

  const targetFolder = await resolveProjectPhotosFolder(job.title);
  logger.info(`[RetryFailed] Ruta destino: "${targetFolder}"`);

  let succeeded = 0;
  let stillFailed = 0;
  let rejectedCount = 0;

  for (const ev of failedEvidences) {
    const storagePath = getStoragePath(ev.url);
    if (!storagePath) {
      logger.error(`[RetryFailed] Evidencia ${ev.id} tiene un formato de url inválido: "${ev.url}"`);
      stillFailed++;
      continue;
    }

    if (succeeded > 0 && succeeded % config.DISK_CHECK_INTERVAL === 0) {
      try {
        const disk = await checkDiskSpace();
        if (!disk.isSafe) {
          throw new Error(`Disco lleno durante reintento. Libre: ${disk.freeMB.toFixed(2)} MB`);
        }
      } catch (err) {
        logger.error(`[RetryFailed] Disk check mid-loop falló para Job ${jobId}: ${err.message}`);
        stillFailed += (failedEvidences.length - succeeded - stillFailed);
        break;
      }
    }

    const originalFilename = path.basename(storagePath);
    const safeFilename = sanitizeFilename(originalFilename);

    if (!isAllowedEvidenceExtension(safeFilename)) {
      logger.warn(`[RetryFailed] Evidencia ${ev.id} rechazada: extensión no permitida ("${safeFilename}"). Solo se aceptan imágenes y PDFs.`);
      stillFailed++;
      rejectedCount++;
      continue;
    }

    const destFilePath = await resolveUniqueFilename(targetFolder, safeFilename);

    try {
      ensurePathWithinBase(destFilePath, targetFolder);

      await downloadFileWithRetry(storagePath, destFilePath);
      await updateEvidenceLocalPath(ev.id, destFilePath);
      succeeded++;
    } catch (err) {
      logger.error(`[RetryFailed] Error reintentando evidencia ${ev.id} (${storagePath}): ${err.message}`);
      stillFailed++;
    }
  }

  logger.info(`[RetryFailed] Resumen para Job ${jobId}: Reintentadas: ${failedEvidences.length}, Exitosas: ${succeeded}, Aun fallidas: ${stillFailed}`);

  if (rejectedCount > 0) {
    metricsTracker.addRejectedByExtension(rejectedCount);
  }

  if (succeeded > 0) {
    metricsTracker.addPhotos(succeeded);
  }

  return { retried: failedEvidences.length, succeeded, stillFailed };
}

module.exports = {
  processJobApproved,
  getStoragePath,
  downloadFileWithRetry,
  updateEvidenceLocalPath,
  markJobAsDownloaded,
  resolveProjectPhotosFolder,
  retryFailedEvidences,
  resolveUniqueFilename,
  cleanupOrphanedPartFiles,
  findProjectFolderRecursive,
  shouldScanDirectory
};

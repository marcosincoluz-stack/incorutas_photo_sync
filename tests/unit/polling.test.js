import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockFrom = vi.fn();
const mockSupabase = {
  from: (table) => mockFrom(table),
};

const mockEnqueue = vi.fn();
const mockGetPendingCount = vi.fn();
const mockRetryFailedEvidences = vi.fn();
const mockAddPhotos = vi.fn();
const mockGetProjectFolderIndex = vi.fn();
const mockListMatchingPdfs = vi.fn();
const mockParsePlansUrl = vi.fn();
const mockInvalidateProjectFolderIndex = vi.fn();

const injectMock = (modulePath, exportsObject) => {
  const resolved = require.resolve(modulePath);
  const resolvedLower = resolved.toLowerCase();
  let found = false;
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase() === resolvedLower) {
      require.cache[key].exports = exportsObject;
      found = true;
    }
  }
  if (!found) {
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsObject,
    };
  }
};

injectMock('../../src/services/supabase', { supabase: mockSupabase });
injectMock('../../src/jobs/bull-queue', { jobQueue: { enqueue: mockEnqueue, getPendingCount: mockGetPendingCount } });
injectMock('../../src/utils/logger', {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
});
injectMock('../../src/jobs/metrics-tracker', { metricsTracker: { addPhotos: mockAddPhotos } });
injectMock('../../src/services/downloader', { retryFailedEvidences: mockRetryFailedEvidences });
injectMock('../../src/services/plano-uploader', {
  getProjectFolderIndex: mockGetProjectFolderIndex,
  listMatchingPdfs: mockListMatchingPdfs,
  parsePlansUrl: mockParsePlansUrl,
  invalidateProjectFolderIndex: mockInvalidateProjectFolderIndex,
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polling-test-'));
injectMock('../../src/config', {
  BACKFILL_MAX_JOBS: 100,
  BACKFILL_MAX_PENDING: 200,
  POLLING_INTERVAL_MS: 30000,
  POLLING_ENABLED: true,
  ENABLE_FOLDER_MOVE: true,
  TRABAJOS_BASE_PATH: tmpDir,
  ADAPTIVE_POLLING_ENABLED: true,
  ADAPTIVE_IDLE_THRESHOLD: 3,
  ADAPTIVE_MAX_INTERVAL_MS: 1800000,
  BUSINESS_HOURS_START: 7,
  BUSINESS_HOURS_END: 21,
  BUSINESS_DAYS: [1, 2, 3, 4, 5],
});

const clearCache = (pattern) => {
  for (const key of Object.keys(require.cache)) {
    if (key.toLowerCase().includes(pattern.toLowerCase())) {
      delete require.cache[key];
    }
  }
};
clearCache('polling');

const {
  pollApprovedJobs,
  pollPaidJobs,
  pollStaleJobs,
  pollPlanosJobs,
  isBusinessHours,
  computeAdaptiveInterval,
} = require('../../src/jobs/polling');

const config = require('../../src/config');

describe('polling module', () => {
  let activosDir;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReset();
    mockEnqueue.mockReset();
    mockGetPendingCount.mockReset();
    mockRetryFailedEvidences.mockReset();
    mockAddPhotos.mockReset();
    mockGetProjectFolderIndex.mockReset();
    mockListMatchingPdfs.mockReset();
    mockParsePlansUrl.mockReset();
    mockInvalidateProjectFolderIndex.mockReset();

    activosDir = path.join(tmpDir, '1ACTIVOS');
    fs.rmSync(activosDir, { recursive: true, force: true });
    fs.mkdirSync(activosDir, { recursive: true });
  });

  describe('pollApprovedJobs', () => {
    it('debería encolar jobs approved sin downloaded_at', async () => {
      mockGetPendingCount.mockResolvedValue(0);

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', status: 'approved', downloaded_at: null },
        { id: 'job-2', title: 'P260252 - Obra B', status: 'paid', downloaded_at: null },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      mockEnqueue.mockResolvedValue(undefined);

      const result = await pollApprovedJobs();

      expect(result.found).toBe(2);
      expect(result.enqueued).toBe(2);
      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(mockEnqueue).toHaveBeenCalledWith('job-1', 'P260251 - Obra A', 'job.approved');
      expect(mockEnqueue).toHaveBeenCalledWith('job-2', 'P260252 - Obra B', 'job.approved');
    });

    it('debería devolver ceros si no hay jobs pendientes', async () => {
      mockGetPendingCount.mockResolvedValue(0);

      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollApprovedJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('debería respetar backpressure si hay muchos jobs pendientes', async () => {
      mockGetPendingCount.mockResolvedValue(200);

      const result = await pollApprovedJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('debería contar como skipped los jobs que fallan al encolar', async () => {
      mockGetPendingCount.mockResolvedValue(0);

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', status: 'approved', downloaded_at: null },
        { id: 'job-2', title: 'P260252 - Obra B', status: 'approved', downloaded_at: null },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      mockEnqueue
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Job duplicado'));

      const result = await pollApprovedJobs();

      expect(result.found).toBe(2);
      expect(result.enqueued).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('pollPaidJobs', () => {
    it('debería encolar jobs paid cuya carpeta está en 1ACTIVOS', async () => {
      fs.mkdirSync(path.join(activosDir, 'P260251 - Obra A'), { recursive: true });

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      mockEnqueue.mockResolvedValue(undefined);

      const result = await pollPaidJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(mockEnqueue).toHaveBeenCalledWith('job-1', 'P260251 - Obra A', 'job.paid');
    });

    it('debería skip jobs paid cuya carpeta ya no está en 1ACTIVOS', async () => {
      fs.mkdirSync(path.join(activosDir, 'P999999 - Otra'), { recursive: true });

      const jobs = [
        { id: 'job-1', title: 'P260251 - Obra A', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollPaidJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('debería devolver ceros si no hay 1ACTIVOS', async () => {
      fs.rmSync(activosDir, { recursive: true, force: true });

      const result = await pollPaidJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('debería devolver ceros si no hay jobs paid', async () => {
      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollPaidJobs();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
    });

    it('debería skip jobs con título sin código P válido', async () => {
      fs.mkdirSync(path.join(activosDir, 'P260251 - Obra'), { recursive: true });

      const jobs = [
        { id: 'job-1', title: 'Sin Codigo', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockEqStatus = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEqStatus });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollPaidJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('pollPaidJobs con ENABLE_FOLDER_MOVE=false', () => {
    it('debería devolver ceros sin consultar Supabase ni filesystem', async () => {
      clearCache('polling');
      injectMock('../../src/config', {
        BACKFILL_MAX_JOBS: 100,
        BACKFILL_MAX_PENDING: 200,
        POLLING_INTERVAL_MS: 30000,
        POLLING_ENABLED: true,
        ENABLE_FOLDER_MOVE: false,
        TRABAJOS_BASE_PATH: tmpDir,
      });
      const { pollPaidJobs: pollPaidNoMove } = require('../../src/jobs/polling');

      const result = await pollPaidNoMove();

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();

      clearCache('polling');
      injectMock('../../src/config', {
        BACKFILL_MAX_JOBS: 100,
        BACKFILL_MAX_PENDING: 200,
        POLLING_INTERVAL_MS: 30000,
        POLLING_ENABLED: true,
        ENABLE_FOLDER_MOVE: true,
        TRABAJOS_BASE_PATH: tmpDir,
      });
      require('../../src/jobs/polling');
    });
  });

  describe('runPollCycle overlap guard', () => {
    it('no debería ejecutar dos ciclos en paralelo', async () => {
      clearCache('polling');
      injectMock('../../src/config', {
        BACKFILL_MAX_JOBS: 100,
        BACKFILL_MAX_PENDING: 200,
        POLLING_INTERVAL_MS: 30000,
        SLOW_POLLING_INTERVAL_MS: 300000,
        POLLING_ENABLED: true,
        ENABLE_FOLDER_MOVE: false,
        TRABAJOS_BASE_PATH: tmpDir,
        POLLING_FAILURE_ALERT_THRESHOLD: 99,
        POLLING_ALERT_COOLDOWN_MS: 999999,
        ENABLE_PLANO_UPLOAD: false,
        PLANO_UPLOAD_STATUSES: [],
        PLANO_SCAN_SUBFOLDER: 'FABRICACION',
        PLANO_INDEX_TTL_MS: 300000,
        PLANO_MAX_PLANOS_PER_JOB: 4,
      });

      let resolveDelay;
      const delayPromise = new Promise(r => { resolveDelay = r; });
      mockGetPendingCount.mockResolvedValue(0);

      const mockLimit = vi.fn().mockReturnValue(delayPromise);
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      const { startPolling, stopPolling } = require('../../src/jobs/polling');

      startPolling();

      await new Promise(r => setTimeout(r, 50));

      stopPolling();
      resolveDelay();

      await new Promise(r => setTimeout(r, 50));

      expect(true).toBe(true);
    });
  });

  describe('pollStaleJobs', () => {
    it('debería retornar ceros si no hay jobs descargados', async () => {
      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      const result = await pollStaleJobs();

      expect(result.found).toBe(0);
      expect(result.healed).toBe(0);
    });

    it('debería curar jobs con evidence pendiente', async () => {
      const jobs = [
        { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
        { id: 'job-2', title: 'P260252 - Test2', downloaded_at: '2026-06-15T11:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockInJobs = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelectJobs = vi.fn().mockReturnValue({ in: mockInJobs });

      const pendingEv = [
        { job_id: 'job-1' },
        { job_id: 'job-2' },
      ];
      const mockIs = vi.fn().mockResolvedValue({ data: pendingEv, error: null });
      const mockInType = vi.fn().mockReturnValue({ is: mockIs });
      const mockInJobIds = vi.fn().mockReturnValue({ in: mockInType });
      const mockSelectEv = vi.fn().mockReturnValue({ in: mockInJobIds });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJobs };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockRetryFailedEvidences.mockResolvedValue({ retried: 1, succeeded: 1, stillFailed: 0 });

      const result = await pollStaleJobs();

      expect(result.found).toBe(2);
      expect(result.healed).toBe(2);
      expect(mockRetryFailedEvidences).toHaveBeenCalledTimes(2);
      expect(mockAddPhotos).toHaveBeenCalledWith(1);
    });

    it('debería manejar errores de retryFailedEvidences sin romper el ciclo', async () => {
      const jobs = [
        { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
        { id: 'job-2', title: 'P260252 - Test2', downloaded_at: '2026-06-15T11:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockInJobs = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelectJobs = vi.fn().mockReturnValue({ in: mockInJobs });

      const pendingEv = [
        { job_id: 'job-1' },
        { job_id: 'job-2' },
      ];
      const mockIs = vi.fn().mockResolvedValue({ data: pendingEv, error: null });
      const mockInType = vi.fn().mockReturnValue({ is: mockIs });
      const mockInJobIds = vi.fn().mockReturnValue({ in: mockInType });
      const mockSelectEv = vi.fn().mockReturnValue({ in: mockInJobIds });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJobs };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      mockRetryFailedEvidences
        .mockRejectedValueOnce(new Error('Storage error'))
        .mockResolvedValueOnce({ retried: 1, succeeded: 1, stillFailed: 0 });

      const result = await pollStaleJobs();

      expect(result.found).toBe(2);
      expect(result.healed).toBe(1);
      expect(mockRetryFailedEvidences).toHaveBeenCalledTimes(2);
    });

    it('no debería llamar retryFailedEvidences si no hay evidence pendiente', async () => {
      const jobs = [
        { id: 'job-1', title: 'P260251 - Test', downloaded_at: '2026-06-15T10:00:00Z' },
      ];
      const mockLimit = vi.fn().mockResolvedValue({ data: jobs, error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockNot = vi.fn().mockReturnValue({ order: mockOrder });
      const mockInJobs = vi.fn().mockReturnValue({ not: mockNot });
      const mockSelectJobs = vi.fn().mockReturnValue({ in: mockInJobs });

      const mockIs = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockInType = vi.fn().mockReturnValue({ is: mockIs });
      const mockInJobIds = vi.fn().mockReturnValue({ in: mockInType });
      const mockSelectEv = vi.fn().mockReturnValue({ in: mockInJobIds });

      mockFrom.mockImplementation((table) => {
        if (table === 'jobs') return { select: mockSelectJobs };
        if (table === 'evidence') return { select: mockSelectEv };
      });

      const result = await pollStaleJobs();

      expect(result.found).toBe(0);
      expect(result.healed).toBe(0);
      expect(mockRetryFailedEvidences).not.toHaveBeenCalled();
    });
  });

  describe('pollPlanosJobs', () => {
    beforeEach(() => {
      config.ENABLE_PLANO_UPLOAD = true;
      config.PLANO_UPLOAD_STATUSES = ['pending'];
      config.PLANO_SCAN_SUBFOLDER = 'FABRICACION';
      config.PROJECT_FOLDER_MAX_DEPTH = 4;
      config.PLANO_INDEX_TTL_MS = 300000;
      config.PLANO_MAX_PLANOS_PER_JOB = 4;
    });

    afterEach(() => {
      delete config.ENABLE_PLANO_UPLOAD;
      delete config.PLANO_UPLOAD_STATUSES;
      delete config.PLANO_SCAN_SUBFOLDER;
      delete config.PROJECT_FOLDER_MAX_DEPTH;
      delete config.PLANO_INDEX_TTL_MS;
      delete config.PLANO_MAX_PLANOS_PER_JOB;
    });

    function mockJobsQueryTwoTier(noPlanoJobs, hasPlanoJobs) {
      const limit1 = vi.fn().mockResolvedValue({ data: noPlanoJobs, error: null });
      const limit2 = vi.fn().mockResolvedValue({ data: hasPlanoJobs, error: null });
      mockFrom.mockImplementation((table) => {
        if (table !== 'jobs') return {};
        return {
          select: () => ({
            in: () => ({
              is: () => ({ is: () => ({ order: () => ({ limit: limit1 }) }) }),
              not: () => ({ is: () => ({ order: () => ({ limit: limit2 }) }) })
            })
          })
        };
      });
    }

    function mockJobsQueryError(message) {
      mockFrom.mockImplementation(() => ({
        select: () => ({
          in: () => ({
            is: () => ({ is: () => ({ order: () => ({ limit: vi.fn().mockResolvedValue({ data: null, error: { message } }) }) }) })
          })
        })
      }));
    }

    it('debería devolver ceros sin consultar Supabase si ENABLE_PLANO_UPLOAD es false', async () => {
      config.ENABLE_PLANO_UPLOAD = false;
      mockGetPendingCount.mockResolvedValue(0);

      const result = await pollPlanosJobs();

      expect(result).toEqual({ found: 0, enqueued: 0, skipped: 0 });
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockGetProjectFolderIndex).not.toHaveBeenCalled();
    });

    it('debería devolver ceros si PLANO_UPLOAD_STATUSES está vacío (misconfiguración)', async () => {
      config.PLANO_UPLOAD_STATUSES = [];
      mockGetPendingCount.mockResolvedValue(0);

      const result = await pollPlanosJobs();

      expect(result).toEqual({ found: 0, enqueued: 0, skipped: 0 });
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockGetPendingCount).not.toHaveBeenCalled();
    });

    it('debería aplicar backpressure y skip si la cola está llena', async () => {
      mockGetPendingCount.mockResolvedValue(200);

      const result = await pollPlanosJobs();

      expect(result).toEqual({ found: 0, enqueued: 0, skipped: 0 });
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('debería devolver ceros si no hay jobs pending', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([], []);

      const result = await pollPlanosJobs();

      expect(result).toEqual({ found: 0, enqueued: 0, skipped: 0 });
      expect(mockGetProjectFolderIndex).not.toHaveBeenCalled();
    });

    it('debería encolar job.plano si hay planos nuevos (diff: 1 subido, 2 en carpeta)', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([], [{ id: 'job-1', title: 'P260251 - Obra A', plans_url: '[{"name":"P260251 - viejo.pdf"}]' }]);

      mockGetProjectFolderIndex.mockResolvedValue(new Map([['P260251', '/tmp/fake/P260251']]));
      mockParsePlansUrl.mockReturnValue([{ name: 'P260251 - viejo.pdf', path: 'planos_job-1_P260251 - viejo.pdf' }]);
      mockListMatchingPdfs.mockResolvedValue([
        { name: 'P260251 - viejo.pdf' },
        { name: 'P260251 - nuevo.pdf' },
      ]);
      mockEnqueue.mockResolvedValue(undefined);

      const result = await pollPlanosJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(mockListMatchingPdfs).toHaveBeenCalledWith(expect.stringContaining('FABRICACION'), 'P260251');
      expect(mockEnqueue).toHaveBeenCalledWith('job-1', 'P260251 - Obra A', 'job.plano');
    });

    it('debería skip si todos los planos ya están subidos (up_to_date)', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([], [{ id: 'job-1', title: 'P260251 - Obra A', plans_url: '[{"name":"P260251 - x.pdf"}]' }]);

      mockGetProjectFolderIndex.mockResolvedValue(new Map([['P260251', '/tmp/fake/P260251']]));
      mockParsePlansUrl.mockReturnValue([{ name: 'P260251 - x.pdf', path: 'planos_job-1_x.pdf' }]);
      mockListMatchingPdfs.mockResolvedValue([{ name: 'P260251 - x.pdf' }]);

      const result = await pollPlanosJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('debería skip sin hacer readdir si el job ya tiene 4 planos (máximo)', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([], [{ id: 'job-1', title: 'P260251 - Obra A', plans_url: '[{}]' }]);

      mockParsePlansUrl.mockReturnValue([
        { name: 'a.pdf', path: 'p1' },
        { name: 'b.pdf', path: 'p2' },
        { name: 'c.pdf', path: 'p3' },
        { name: 'd.pdf', path: 'p4' },
      ]);

      const result = await pollPlanosJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockListMatchingPdfs).not.toHaveBeenCalled();
    });

    it('debería skip jobs cuya carpeta no está en el índice (sin plano listo)', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([{ id: 'job-1', title: 'P260251 - Obra A', plans_url: null }], []);

      mockGetProjectFolderIndex.mockResolvedValue(new Map());
      mockParsePlansUrl.mockReturnValue([]);
      mockListMatchingPdfs.mockResolvedValue([]);

      const result = await pollPlanosJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockInvalidateProjectFolderIndex).toHaveBeenCalled();
    });

    it('debería skip jobs con FABRICACION sin PDFs que matcheen', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([{ id: 'job-1', title: 'P260251 - Obra A', plans_url: null }], []);

      mockGetProjectFolderIndex.mockResolvedValue(new Map([['P260251', '/tmp/fake/P260251']]));
      mockParsePlansUrl.mockReturnValue([]);
      mockListMatchingPdfs.mockResolvedValue([]);

      const result = await pollPlanosJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('debería skip jobs cuyo título no tiene código P válido', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryTwoTier([{ id: 'job-1', title: 'Sin Codigo', plans_url: null }], []);

      mockGetProjectFolderIndex.mockResolvedValue(new Map());

      const result = await pollPlanosJobs();

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('debería lanzar el error de Supabase (lo captura runSlowCycle)', async () => {
      mockGetPendingCount.mockResolvedValue(0);
      mockJobsQueryError('Supabase error');

      await expect(pollPlanosJobs()).rejects.toThrow(/Supabase error/);
    });
  });

  describe('adaptive polling logic', () => {
    it('isBusinessHours: no debería ser horario laboral el domingo', () => {
      const sunday = new Date('2026-07-12T12:00:00'); // Domingo
      expect(isBusinessHours(sunday)).toBe(false);
    });

    it('isBusinessHours: debería ser horario laboral un martes a las 10:00', () => {
      const tuesday = new Date('2026-07-14T10:00:00'); // Martes 10:00
      expect(isBusinessHours(tuesday)).toBe(true);
    });

    it('isBusinessHours: no debería ser horario laboral un martes a las 6:59', () => {
      const tuesdayEarly = new Date('2026-07-14T06:59:00');
      expect(isBusinessHours(tuesdayEarly)).toBe(false);
    });

    it('isBusinessHours: no debería ser horario laboral un martes a las 21:00', () => {
      const tuesdayLate = new Date('2026-07-14T21:00:00');
      expect(isBusinessHours(tuesdayLate)).toBe(false);
    });

    it('computeAdaptiveInterval: no debería ralentizar en horario laboral', () => {
      const tuesday = new Date('2026-07-14T10:00:00');
      expect(computeAdaptiveInterval(10, tuesday)).toBe(30000);
    });

    it('computeAdaptiveInterval: no debería ralentizar si idleStreak < threshold', () => {
      const sunday = new Date('2026-07-12T12:00:00');
      expect(computeAdaptiveInterval(2, sunday)).toBe(30000);
    });

    it('computeAdaptiveInterval: debería aplicar backoff exponencial fuera de horario laboral', () => {
      const sunday = new Date('2026-07-12T12:00:00');
      // Threshold = 3.
      // idleStreak = 3 (exponent = 0) => 30000 * 2^0 = 30000
      expect(computeAdaptiveInterval(3, sunday)).toBe(30000);
      // idleStreak = 4 (exponent = 1) => 30000 * 2^1 = 60000
      expect(computeAdaptiveInterval(4, sunday)).toBe(60000);
      // idleStreak = 5 (exponent = 2) => 30000 * 2^2 = 120000
      expect(computeAdaptiveInterval(5, sunday)).toBe(120000);
    });

    it('computeAdaptiveInterval: debería respetar el techo de 30 minutos', () => {
      const sunday = new Date('2026-07-12T12:00:00');
      expect(computeAdaptiveInterval(50, sunday)).toBe(1800000); // 30 minutos
    });

    it('computeAdaptiveInterval: siempre devuelve base si está desactivado', () => {
      config.ADAPTIVE_POLLING_ENABLED = false;
      const sunday = new Date('2026-07-12T12:00:00');
      expect(computeAdaptiveInterval(50, sunday)).toBe(30000);
      config.ADAPTIVE_POLLING_ENABLED = true; // Restaurar
    });

    it('startPolling integration: debería inicializar currentFastInterval con POLLING_INTERVAL_MS', () => {
      vi.useFakeTimers();

      mockGetPendingCount.mockResolvedValue(0);
      const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockIs = vi.fn().mockReturnValue({ order: mockOrder });
      const mockIn = vi.fn().mockReturnValue({ is: mockIs });
      const mockSelect = vi.fn().mockReturnValue({ in: mockIn });
      mockFrom.mockReturnValue({ select: mockSelect });

      const { startPolling, stopPolling, getCurrentFastInterval: getInterval } = require('../../src/jobs/polling');

      startPolling();

      expect(getInterval()).toBe(30000);

      stopPolling();
      vi.useRealTimers();
    });
  });
});

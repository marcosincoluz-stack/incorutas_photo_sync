# AGENTS.md — Incorutas Photo Sync

## Project Overview
Middleware Express que sincroniza fotos desde Supabase Storage a un servidor de archivos local (SMB) y gestiona el ciclo de vida de carpetas de trabajo (1ACTIVOS → TERMINADOS).

## Project Structure

```
src/
  index.js              — Entry point: Express app, mounts routers + error handler + requestId + requestLogger + unhandledRejection
  config.js            — Env validation, startup checks, security warnings (sync fs OK here only)
  banner.js             — ASCII banner + startup Telegram; detecta crash leyendo marcador (consume/borra si graceful)
  shutdown.js           — Graceful shutdown: escribe marcador de cierre limpio → Telegram → closeAllConnections → drain jobs → close Redis → persist metrics
  routes/
    diagnostic.js      — GET /health (public, minimal), /status + /metrics (auth required, detailed)
    api.js              — GET /dashboard (5s cache), /config, /logs (5s cache), /failed-evidences (5s cache), /pending-planos (5s cache); POST /backfill (backpressure), /retry-failed/:jobId, /upload-plano/:jobId, /test-telegram
    dlq.js              — GET /dlq (5s cache); POST /dlq/retry, /dlq/clear (cache invalidation)
  services/
    downloader.js        — Core download logic (atomic .part writes, exponential backoff, Supabase query timeout)
    folder-mover.js      — Move/copy/trash folders (1ACTIVOS → TERMINADOS), lock-protected collision resolution
    plano-uploader.js    — Upload job blueprint PDF (FABRICACION) to mounting-orders bucket, set jobs.plans_url
    supabase.js          — Singleton Supabase client (service_role key)
  jobs/
    bull-queue.js        — BullMQ queue/worker orchestrator (circuit breaker, stalled job detection). Events: job.approved | job.paid | job.plano
    polling.js           — Polling híbrido 2 timers: approved cada 30s (latencia imágenes), paid+stale+planos cada 5min (reduce egress 70%)
    error-classifier.js  — Pure error classification (replaces inline string-matching)
    metrics-tracker.js   — Job metrics (onCompleted, onFailed, addPhotos, addPlanos, getStatus)
    dlq-handler.js        — Dead letter queue operations (getFailedJobs, retryFailedJob, clearFailedJobs)
  middleware/
    api-auth.js          — Bearer token auth for /api/* routes (timing-safe)
    error-handler.js     — Centralized JSON error responses (no leak in prod)
    request-id.js        — UUID request ID middleware (X-Request-Id header + AsyncLocalStorage for log correlation)
    request-logger.js    — HTTP request logging (method, path, status, duration — skips /health)
  utils/
    async-handler.js     — Express async error wrapper
    circuit-breaker.js   — Generic circuit breaker (CLOSED → OPEN → HALF_OPEN)
    disk.js              — fs.statfs-based disk space check (with timeout)
    lock.js              — Memory/Redis lock provider (async release, concurrency control)
    logger.js            — Winston with daily rotation (14d info, 30d errors) + AsyncLocalStorage for request ID
    metrics-store.js     — Persistent counters (historical + session, 60s flush, NaN validation)
    notify.js            — Telegram alerts (HTML-escaped, truncated to 4000 chars)
    redis-connection.js  — Shared Redis singleton (used by BullMQ and lock)
    sanitize.js          — Filename sanitization + path traversal prevention
    tail-file.js         — Efficient last-N-lines log reader (stream-based, capped, partial-line skip)
  validations/
    dlq.js               — Zod schema for DLQ retry (bullJobId, max 200)
    retry.js             — Zod schema for retry-failed (jobId, max 100)
  public/
    index.html           — Dashboard markup
    css/styles.css       — Dashboard styles
    js/app.js            — Dashboard logic (AbortController, sessionStorage, 5s auto-refresh)

scripts/
  backfill.js           — CLI retroactive download script (--dry-run, --yes, --job-id=, --retry-failed)

tests/
  setup.js                — Shared env vars for all test files
  unit/                    — Unit tests (vitest)
  integration/             — Integration tests (Express server)
```

## Commands

```bash
npm start                # Production start
npm run dev              # Dev mode (NODE_ENV=development)
npm test                 # Run all tests (vitest)
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report (v8)
npm run lint             # ESLint on src/ + tests/
npm run backfill         # CLI retroactive download
npm run backfill:dry     # Dry-run retroactive download
```

## Key Conventions

- **No TypeScript.** JSDoc for type annotations on all public functions.
- **Zod** for input validation. Schemas in `src/validations/`. All string fields have `.max()`.
- **All routes** use `asyncHandler()` + centralized `errorHandler`.
- **API versioned** under `/v1/`, legacy paths preserved without prefix (no 301 redirects — POST requests change method on redirect).
- **No `fs` sync calls** at runtime. Only at startup in `config.js`, `logger.js`, `metrics-store.js`, `banner.js`.
- **`mkdir({ recursive: true })`** without prior `existsSync` — idempotent by design.
- **BullMQ** processes jobs sequentially (`concurrency: 1`, `limiter: 1/1000ms`). Stalled job detection (30s interval, 60s lock duration).
- **Lock provider** pattern for folder creation + folder move concurrency control (`MemoryLockProvider` default, `RedisLockProvider` via SET NX+PX for multi-instance). `release()` is async.
- **Polling híbrido 2 timers**: el timer rápido (`POLLING_INTERVAL_MS`, 30s) ejecuta `pollApprovedJobs` para máxima latencia de imágenes. El timer lento (`SLOW_POLLING_INTERVAL_MS`, 5min) ejecuta `pollPaidJobs` + `pollStaleJobs` + `pollPlanosJobs` (no críticos). Reduce egress 70% sin afectar latencia de descarga. No ports open to internet, no Edge Function needed.
- **`/logs` endpoint** uses stream-based tail reading (`tailFile()`) capped at `LOG_TAIL_MAX_BYTES` (64KB default). Partial first line is skipped.
- **Error classification** prioritizes `err.code` (Node.js native: ENOSPC, ENOENT, EIO, ECONNRESET, etc.) over `err.message` substring matching.
- **Partial download tolerance** via `DOWNLOAD_TOLERANCE_PERCENT` (default 0 = strict). If errors <= tolerance, job is marked `downloaded` with warnings.
- **Atomic file downloads**: writes to `dest.part`, renames to `dest` only on success. Partial files are always cleaned up.
- **Exponential backoff** in `downloadFileWithRetry`: `baseDelay * 2^(attempt-1)`.
- **Supabase query timeout**: `withTimeout()` wraps queries with 10s deadline via `Promise.race`.
- **Circuit breaker** wraps `processJobApproved` and `moveJobToTerminados`. Opens after 5 consecutive failures, resets after 30s.
- **Timing-safe comparison** for API tokens (`crypto.timingSafeEqual`).
- **Dashboard** API calls use `window.location.origin + '/v1'`, token stored in `sessionStorage` (not localStorage). `AbortController` cancels stale requests.
- **`downloaded_at`** used as idempotency key — skipped if already set.
- **Error handler** doesn't expose error details unless `err.expose === true`.
- **Telegram notifications** escape HTML entities (`<`, `>`, `&`) and truncate to 4000 chars (Telegram limit: 4096).
- **Request ID** propagated via `AsyncLocalStorage` — appears in all log lines as `[request-uuid]`.
- **Request logging** middleware logs `METHOD PATH STATUS durationMs` for every request (except `/health`).
- **Graceful shutdown** calls `server.closeAllConnections()` after 2s to force-close keep-alive, then drains queue, closes Redis, persists metrics.
- **ESLint**: 0 errors, 0 warnings required before merge.
- **Pre-commit**: `husky` + `lint-staged` runs ESLint on `*.js` files.

## Architecture Decisions

| Decision | Rationale |
|---|---|
| No build step for dashboard | Simplicity; just static HTML/CSS/JS |
| Late require removed from downloader | All imports at top-level; `jobQueue` imported once |
| `safeFilename` → `path.basename(destFilePath)` | Fixed ReferenceError in file-size check |
| Legacy routes without redirect | POST `fetch()` changes method on 301 |
| Sync fs only at startup | `config.js`, `logger.js`, `metrics-store.js`, `banner.js` — run once |
| EXDEV fallback with trash | Cross-filesystem moves use cp+verify+trash instead of rm |
| `/health` public (minimal), `/status` auth (detailed) | Health checks need no auth but shouldn't expose system info |
| Dashboard + secondary endpoints 5s cache | Avoids hammering Supabase/Redis on rapid refresh |
| `--dev` flag removed | `NODE_ENV=development` only; no argv bypass |
| `localStorage` → `sessionStorage` | Token cleared on tab close; no persistent credential leak |
| `requestId` + `AsyncLocalStorage` | Every request gets `X-Request-Id` header + log correlation |
| Graceful shutdown marker consumed on boot | Crash detection reads `data/.last_graceful_shutdown` once and deletes it; if the process later dies without graceful shutdown, next boot reports crash. Marker is written BEFORE Telegram shutdown notification so a hung API call never causes a false "crash". |
| `requestLogger` middleware | HTTP request tracing with method/path/status/duration |
| `sharp.cache` limited | `sharp.cache({ memory: 16, files: 0, items: 20 })` at downloader module load: prevents ~50MB+ internal cache accumulation with BullMQ worker. Guarded with typeof check for mocks. |
| `cross-env` for dev script | Windows-compatible `NODE_ENV=development` |
| Polling híbrido 2 timers | Timer rápido (30s) para approved (latencia imágenes), timer lento (5min) para paid+stale+planos. Reduce egress 70% sin afectar descarga. |
| Webhook dedup via Redis SETNX | ~~Deprecated~~ Removed with webhook subsystem |
| Tail-based `/logs` | Stream reader capped at 64KB; partial line skip; no OOM |
| Error classifier `err.code` priority | Robust multi-locale error detection (ENOSPC, ENOENT, EIO, ECONNRESET) |
| `RedisLockProvider` implemented | `SET NX PX` + Lua safe release (async); enables horizontal scaling |
| Download tolerance `DOWNLOAD_TOLERANCE_PERCENT` | Jobs with partial failures within tolerance still marked as downloaded |
| Retry failed evidences | `retryFailedEvidences()` re-downloads `local_path IS NULL` photos; never touches `downloaded_at` or BullMQ; idempotent by design |
| Atomic `.part` downloads | Prevents partial/corrupt files from being treated as complete |
| Exponential backoff in downloads | Better backpressure handling than linear |
| Circuit breaker for Supabase | Stops wasting resources when Supabase is down; auto-recovers |
| `server.closeAllConnections()` in shutdown | Forces keep-alive closure so shutdown doesn't hang |
| `unhandledRejection` handler | Logs promise rejections without crashing |
| `uncaughtException` handler | Logs and exits (unsafe to continue after uncaught) |
| HTML escaping in Telegram | Prevents HTML injection via error messages or filenames |
| `MAX_COLLISIONS` in config | Was hardcoded in folder-mover.js; now configurable |
| `SUPABASE_BUCKET` configurable | Was hardcoded as `'evidence'`; now configurable |
| Plano upload to `mounting-orders` | Reverse flow (Server → Supabase). Reads PDFs starting with P-code from `FABRICACION/`, validates `%PDF-`+`%%EOF`, uploads up to 4 with `upsert:true`, verifies via `.exists()`, stores `plans_url` as JSON array of `{name,path}`. Auto-append: polling diffs FABRICACION vs `plans_url` (by name), enqueues only on new. `job.plano` re-enqueueable after `completed` (BullMQ dedup bypass for auto-append). |
| `plans_url` as JSON array of `{name,path}` | Auto-append needs original names to diff. Lock `plano:<jobId>` prevents concurrent append. UPDATE is `WHERE id` (append, not `WHERE IS NULL`). |
| Stalled job detection | Worker detects crashed jobs after 30s instead of BullMQ default |
| Backpressure in `/backfill` | Rejects with 429 if queue has >= 200 pending jobs |
| N+1 eliminated in `/failed-evidences` | 2 fixed queries instead of up to 201 per refresh |
| `AbortController` in dashboard | Cancels stale HTTP requests when a new refresh starts |
| Metrics NaN validation | Corrupt `metrics.json` doesn't propagate NaN to Prometheus/dashboard |

## Environment Variables

See `.env.example` for the full list. Critical vars:
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` — Supabase connection (bucket default: `evidence`)
- `SUPABASE_PLANOS_BUCKET` — Bucket for job blueprints (default: `mounting-orders`, separate from `evidence`)
- `API_TOKEN` — Bearer token for /api/* routes
- `TRABAJOS_BASE_PATH` — Local SMB mount point
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` — BullMQ Redis connection
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — Alert notifications (optional)
- `ENABLE_PLANO_UPLOAD`, `PLANO_SCAN_SUBFOLDER`, `PLANO_MAX_SIZE_MB`, `PLANO_UPLOAD_STATUSES` — Plano upload feature (Sprint 1+)

## Testing

- **Framework**: Vitest (ESM-compatible)
- **Runner**: `npm test` (single run) or `npm run test:watch`
- **Coverage**: `npm run test:coverage` — includes `src/**/*.js`, excludes `src/public/**`
- **Current count**: 328 tests across 26 files
- **Mocking strategy**: `injectMock` + `require.cache` pattern for CJS external modules (`bullmq`, `ioredis`); `vi.fn()` for simple mocks; integration tests spin up an actual Express server
- **Pre-commit**: `husky` + `lint-staged` runs ESLint on `*.js` on every commit

## Config Constants (config.js)

Magic constants are centralized in `config.js`. Key exports beyond env vars:
- `LIMITER_MAX`, `LIMITER_DURATION_MS` — BullMQ rate limiter
- `REMOVE_ON_MAX` (default 20), `RECENT_JOBS_MAX` — Job retention
- `TELEGRAM_TIMEOUT_MS` — Telegram API timeout
- `DASHBOARD_CACHE_TTL_MS` — Dashboard response cache (5s)
- `SECONDARY_CACHE_TTL_MS` — Cache for /dlq, /failed-evidences, /logs (5s)
- `MIN_DISK_MB` — Minimum disk space threshold
- `BACKFILL_MAX_JOBS` — Retroactive download batch limit
- `BACKFILL_MAX_PENDING` — Backpressure limit for /backfill (200 default)
- `MAX_COLLISIONS` — Folder rename collision limit (100 default)
- `DISK_CHECK_INTERVAL` — Re-check disk space every N photos during download (default 10)
- `PART_CLEANUP_ON_STARTUP` — Clean orphaned .part files on worker startup (default true)
- `MAX_EVIDENCES_PER_JOB` — Max photos per job (150 default)
- `LOG_TAIL_MAX_BYTES` — Max bytes read from log file (default 64KB)
- `DOWNLOAD_TOLERANCE_PERCENT` — Allowed % of photo download failures (default 0 = strict)
- `SUPABASE_BUCKET` — Supabase Storage bucket name (default: `evidence`)
- `POLLING_INTERVAL_MS` — Polling interval rápido: approved jobs (default 30000)
- `SLOW_POLLING_INTERVAL_MS` — Polling interval lento: paid+stale+planos (default 300000)
- `POLLING_ENABLED` — Enable/disable polling (default true)
- `POLLING_FAILURE_ALERT_THRESHOLD` — Consecutive failures before Telegram alert (default 3)
- `POLLING_ALERT_COOLDOWN_MS` — Alert cooldown to prevent spam (default 300000)
- `HEALTH_PING_TIMEOUT_MS` — Per-dependency ping timeout in /health (default 3000)
- `CIRCUIT_BREAKER_THRESHOLD` — Failures before circuit opens (default 5)
- `CIRCUIT_BREAKER_RESET_MS` — Time before circuit half-opens (default 30000)
- `STALLED_INTERVAL_MS` — BullMQ stalled job check interval (default 30000)
- `LOCK_DURATION_MS` — BullMQ job lock duration (default 60000)
- `ENABLE_PLANO_UPLOAD` — Enable plano upload feature (default true)
- `SUPABASE_PLANOS_BUCKET` — Bucket for planos (default `mounting-orders`)
- `PLANO_SCAN_SUBFOLDER` — Project subfolder to scan for PDF (default `FABRICACION`)
- `PLANO_MAX_SIZE_MB` — Max plano size; read to Buffer for validation (default 50)
- `PLANO_MAX_PLANOS_PER_JOB` — Max planos per job; extras omitted with alert (default 4)
- `PLANO_UPLOAD_STATUSES` — Job statuses to scan for plano upload (default `pending`)
- `PROJECT_FOLDER_MAX_DEPTH` — Max depth when searching project folders (default 4)
- `PLANO_INDEX_TTL_MS` — TTL of cached P-code→folder index (default 300000, reduces SMB readdir)

## Known Issues (Separate from Maintainability)

| ID | Severity | Description |
|---|---|---|
| ~~S1~~ | ~~Critical~~ Mitigated | `.env.example` with placeholders only; `.env` permissions check at startup (`chmod 600`); service_role key NOT in config exports |
| ~~S2~~ | ~~High~~ Resolved | `/status` + `/metrics` require `verifyApiToken`; `/health` remains public (minimal info only) |
| ~~S3~~ | ~~Medium~~ Resolved | `--dev` argv removed; dev mode via `NODE_ENV=development` only |
| S4 | Medium | `service_role` key accessible from any module (mitigated: only `process.env` in `supabase.js`) |
| ~~S5~~ | ~~Low~~ Resolved | `REDIS_PASSWORD` documented in `.env.example` + startup warning if empty in production |
| ~~S6~~ | ~~Low~~ Resolved | API token stored in `sessionStorage` instead of `localStorage` |
| ~~S7~~ | ~~Medium~~ Resolved | HTML injection in Telegram notifications — `escapeHtml()` applied to all dynamic content |
| ~~R1~~ | ~~Medium~~ Resolved | String-matching replaced by `error-classifier.js` with `err.code` priority |
| ~~R2~~ | ~~Medium~~ Resolved | Webhook subsystem removed — polling replaces webhooks entirely |
| ~~R3~~ | ~~Medium~~ Resolved | `/logs` uses stream-based tail reading (capped 64KB, no OOM) |
| ~~R4~~ | ~~Medium~~ Resolved | `RedisLockProvider` implemented (SET NX PX + Lua safe release, async) |
| ~~R5~~ | ~~Medium~~ Resolved | Error classifier prioritizes `err.code` over `err.message` substring matching |
| ~~R6~~ | ~~Medium~~ Resolved | `DOWNLOAD_TOLERANCE_PERCENT` allows partial failure tolerance |
| ~~R7~~ | ~~Medium~~ Resolved | Circuit breaker stops cascading failures when Supabase is down |
| ~~R8~~ | ~~Medium~~ Resolved | `retryFailedEvidences()` re-downloads failed photos via `local_path IS NULL` query; never creates BullMQ jobs or modifies `downloaded_at` |
| ~~R9~~ | ~~High~~ Resolved | Atomic `.part` downloads prevent corrupt files from being marked as complete |
| ~~R10~~ | ~~High~~ Resolved | Graceful shutdown uses `closeAllConnections()` to avoid hanging on keep-alive |
| ~~R11~~ | ~~Medium~~ Resolved | `/health` timeout via `Promise.race` — no hang on frozen SMB mount |
| ~~R12~~ | ~~Medium~~ Resolved | N+1 queries eliminated in `/failed-evidences` (2 fixed queries) |
| ~~R13~~ | ~~Medium~~ Resolved | Backpressure in `/backfill` — 429 if queue has >= 200 pending |
| ~~R14~~ | ~~Low~~ Resolved | Dashboard `AbortController` cancels stale requests |
| ~~R15~~ | ~~Low~~ Resolved | `unhandledRejection` + `uncaughtException` handlers |
| ~~R16~~ | ~~Low~~ Resolved | Polling replaces Edge Function — no Supabase-side retry needed. Middleware auto-detects pending jobs every 30s. |
| R17 | Low | Race condition in `downloaded_at` idempotency check (TOCTOU). Mitigated by BullMQ job ID dedup. Full fix would require DB-level `SELECT FOR UPDATE`. |

## Deployment Notes

- `.env` must have `chmod 600` permissions — startup warns if group/other can read
- systemd `EnvironmentFile=` supported (see README for unit file example)
- `SUPABASE_SERVICE_KEY` is read directly from `process.env` in `supabase.js`, never exported via `config.js`
- `/health` is public (for load balancers) — exposes only `status`, `uptime`, `smb_mounted`, `disk`, `version`
- `/status` and `/metrics` require `verifyApiToken` — expose memory, node version, platform, queue details
- `REDIS_PASSWORD` required in production; empty value triggers startup warning
- Circuit breaker opens after 5 consecutive Supabase failures — jobs fail fast instead of hanging
- Stalled jobs detected after 30s — automatically reprocessed by BullMQ
- Graceful shutdown: 2s drain → `closeAllConnections()` → `stopPolling()` → 30s queue drain → Redis close → metrics persist → write graceful-shutdown marker (before Telegram) → Telegram shutdown notify → 35s force exit
- Polling híbrido: timer rápido cada 30s (`POLLING_INTERVAL_MS`) ejecuta `pollApprovedJobs` (latencia imágenes). Timer lento cada 5min (`SLOW_POLLING_INTERVAL_MS`) ejecuta `pollPaidJobs` + `pollStaleJobs` + `pollPlanosJobs`. Reduce egress 70%. No ports open to internet needed.
- `POLLING_ENABLED=false` disables polling (useful for manual-only mode via `/backfill`)
- Polling alerts via Telegram after 3 consecutive failures (`POLLING_FAILURE_ALERT_THRESHOLD`), with 5min cooldown (`POLLING_ALERT_COOLDOWN_MS`)
- `/health` (public) pings Redis + Supabase + SMB with `HEALTH_PING_TIMEOUT_MS` timeout per dependency
- Docker: `docker compose up -d` runs middleware + Redis with `requirepass` (see `docker-compose.yml`)

import fs from 'node:fs';
import path from 'node:path';
import {
  ACTORS,
  CHECKPOINT_EVERY_CONTACTS,
  DEFAULT_BATCH_MAX_TOTAL_CHARGE_USD,
  DEFAULT_CONCURRENCY,
  MAX_CONSECUTIVE_NON_TEMP_FAILURES,
  MAX_RETRIES,
  STATES,
} from './constants.js';
import {
  backoffMs,
  createApifyClient,
  isAuthOrBalanceError,
  isNonRetryableError,
  runActorExtraction,
  sleep,
} from './apify.js';
import { getMaxTotalChargeUsdBatch, getMaxTotalChargeUsdPerRun, redactSecrets } from './env.js';
import {
  ensureManifestForContacts,
  findManifestRow,
  loadManifest,
  saveManifest,
  upsertManifestRow,
} from './manifest.js';
import {
  ensureOutputDirs,
  getOutputPaths,
  postsRawPath,
  profileRawPath,
  sanitizeFilename,
} from './paths.js';
import { validateActorResultShape } from './schema.js';

function rawPathFor(paths, tipo, handle) {
  const safe = sanitizeFilename(handle);
  return tipo === 'profile' ? profileRawPath(paths, safe) : postsRawPath(paths, safe);
}

export function isValidRawJson(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed != null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

export function shouldSkipJob(manifestRows, paths, handle, tipo, force) {
  if (force) return { skip: false };
  const row = findManifestRow(manifestRows, handle, tipo);
  const filePath = rawPathFor(paths, tipo, handle);
  if (row?.estado === STATES.SUCCEEDED && isValidRawJson(filePath)) {
    return { skip: true, reason: 'ya exitoso con JSON válido' };
  }
  if ((!row || row.estado !== STATES.SUCCEEDED) && isValidRawJson(filePath) && !force) {
    return { skip: true, reason: 'archivo crudo válido existente' };
  }
  return { skip: false };
}

function buildJobs(contacts, { profilesOnly, postsOnly, profileFilter }) {
  let list = contacts.filter((c) => c.handle);
  if (profileFilter) {
    list = list.filter(profileFilter);
  }
  const tipos = [];
  if (profilesOnly && !postsOnly) tipos.push('profile');
  else if (postsOnly && !profilesOnly) tipos.push('posts');
  else {
    tipos.push('profile', 'posts');
  }

  const jobs = [];
  for (const contact of list) {
    for (const tipo of tipos) {
      jobs.push({ contact, tipo, actorId: ACTORS[tipo].id });
    }
  }
  return jobs;
}

function sumManifestCost(rows) {
  let total = 0;
  for (const row of rows) {
    if (row.estado !== STATES.SUCCEEDED) continue;
    const n = Number(row.costo_usd);
    if (Number.isFinite(n)) total += n;
  }
  return Number(total.toFixed(6));
}

function contactCompletionKey(handle) {
  return handle;
}

function writeCheckpoint({
  paths,
  checkpointIndex,
  contactsCompleted,
  accumulatedCost,
  stopReason,
  pendingRemaining,
  succeeded,
  failed,
  skipped,
  consecutiveNonTempFailures,
  logger,
}) {
  fs.mkdirSync(paths.checkpoints, { recursive: true });
  const payload = {
    checkpoint: checkpointIndex,
    generated_at: new Date().toISOString(),
    contacts_completed: contactsCompleted,
    accumulated_cost_usd: accumulatedCost,
    pending_jobs_remaining: pendingRemaining,
    succeeded_jobs: succeeded,
    failed_jobs: failed,
    skipped_jobs: skipped,
    consecutive_non_temp_failures: consecutiveNonTempFailures,
    stop_reason: stopReason || null,
  };
  const file = path.join(paths.checkpoints, `checkpoint_${String(checkpointIndex).padStart(3, '0')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  logger.info(
    `Checkpoint #${checkpointIndex}: contactos_completados=${contactsCompleted} costo_acumulado_usd=${accumulatedCost}`,
  );
  return file;
}

export async function extractContacts({
  contacts,
  logger,
  force = false,
  concurrency = DEFAULT_CONCURRENCY,
  profilesOnly = false,
  postsOnly = false,
  profileFilter = null,
  projectRoot,
  batchMaxChargeUsd,
}) {
  const paths = getOutputPaths(projectRoot);
  ensureOutputDirs(paths);
  fs.mkdirSync(paths.checkpoints, { recursive: true });

  const maxPerRun = getMaxTotalChargeUsdPerRun();
  const maxBatch = batchMaxChargeUsd ?? getMaxTotalChargeUsdBatch(DEFAULT_BATCH_MAX_TOTAL_CHARGE_USD);

  const client = createApifyClient();
  let manifestRows = loadManifest(paths.manifestCsv);
  manifestRows = ensureManifestForContacts(manifestRows, contacts, ACTORS);
  saveManifest(paths.manifestCsv, manifestRows);

  const jobs = buildJobs(contacts, { profilesOnly, postsOnly, profileFilter });
  const pending = [];
  let skipped = 0;

  for (const job of jobs) {
    const decision = shouldSkipJob(manifestRows, paths, job.contact.handle, job.tipo, force);
    if (decision.skip) {
      skipped += 1;
      const existing = findManifestRow(manifestRows, job.contact.handle, job.tipo) || {};
      const filePath = rawPathFor(paths, job.tipo, job.contact.handle);
      const keepSucceeded = existing.estado === STATES.SUCCEEDED || isValidRawJson(filePath);
      upsertManifestRow(manifestRows, {
        ...existing,
        handle: job.contact.handle,
        nombre: job.contact.nombre,
        institución: job.contact.institución,
        cargo: job.contact.cargo,
        prioridad: job.contact.prioridad,
        tipo_extracción: job.tipo,
        actor_id: job.actorId,
        estado: keepSucceeded ? STATES.SUCCEEDED : STATES.SKIPPED,
        archivo_local: filePath,
        error: keepSucceeded ? '' : decision.reason,
      });
      logger.info(`Omitido ${job.tipo} ${job.contact.handle}: ${decision.reason}`);
    } else {
      pending.push(job);
    }
  }
  saveManifest(paths.manifestCsv, manifestRows);

  let accumulatedCost = sumManifestCost(manifestRows);
  logger.info(
    `Trabajos pendientes: ${pending.length} | omitidos=${skipped} | concurrencia=${concurrency} | costo_inicial_usd=${accumulatedCost} | límite_lote_usd=${maxBatch} | límite_run_usd=${maxPerRun ?? 'n/d'}`,
  );

  let manifestChain = Promise.resolve();
  const persistManifest = () => {
    const run = () => saveManifest(paths.manifestCsv, manifestRows);
    manifestChain = manifestChain.then(run, run);
    return manifestChain;
  };

  const state = {
    stopReason: null,
    accumulatedCost,
    consecutiveNonTempFailures: 0,
    succeeded: 0,
    failed: 0,
    retries: 0,
    contactsFullyDone: new Set(),
    contactsSeenDone: new Set(),
    checkpointIndex: 0,
    checkpointFiles: [],
    nextIndex: 0,
  };

  // Contacts already complete (both tipos succeeded/skipped with raw) count toward baseline
  const requiredTipos = profilesOnly && !postsOnly
    ? ['profile']
    : postsOnly && !profilesOnly
      ? ['posts']
      : ['profile', 'posts'];

  const markContactProgress = (handle) => {
    const done = requiredTipos.every((tipo) => {
      const row = findManifestRow(manifestRows, handle, tipo);
      return row && [STATES.SUCCEEDED, STATES.SKIPPED].includes(row.estado);
    });
    if (!done) return;
    if (state.contactsSeenDone.has(handle)) return;
    state.contactsSeenDone.add(handle);
    state.contactsFullyDone.add(handle);
    if (state.contactsFullyDone.size % CHECKPOINT_EVERY_CONTACTS === 0) {
      state.checkpointIndex += 1;
      const file = writeCheckpoint({
        paths,
        checkpointIndex: state.checkpointIndex,
        contactsCompleted: state.contactsFullyDone.size,
        accumulatedCost: state.accumulatedCost,
        stopReason: state.stopReason,
        pendingRemaining: Math.max(0, pending.length - state.succeeded - state.failed),
        succeeded: state.succeeded,
        failed: state.failed,
        skipped,
        consecutiveNonTempFailures: state.consecutiveNonTempFailures,
        logger,
      });
      state.checkpointFiles.push(file);
    }
  };

  // Seed completed contacts (e.g. pilot) so checkpoints continue from reality
  for (const contact of contacts.filter((c) => c.handle)) {
    const done = requiredTipos.every((tipo) => {
      const row = findManifestRow(manifestRows, contact.handle, tipo);
      return row && row.estado === STATES.SUCCEEDED;
    });
    if (done) {
      state.contactsSeenDone.add(contactCompletionKey(contact.handle));
      state.contactsFullyDone.add(contactCompletionKey(contact.handle));
    }
  }

  const requestStop = (reason) => {
    if (!state.stopReason) {
      state.stopReason = reason;
      logger.error(`STOP: ${reason}`);
    }
  };

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      if (state.stopReason) return;

      if (state.accumulatedCost >= maxBatch) {
        requestStop(`costo acumulado alcanzó límite global USD ${maxBatch}`);
        return;
      }

      const current = state.nextIndex;
      state.nextIndex += 1;
      if (current >= pending.length) return;

      const job = pending[current];
      const { contact, tipo, actorId } = job;
      const filePath = rawPathFor(paths, tipo, contact.handle);

      if (state.stopReason) return;

      let lastError = null;
      let attempts = 0;
      let jobSucceeded = false;

      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
        if (state.stopReason) break;
        if (state.accumulatedCost >= maxBatch) {
          requestStop(`costo acumulado alcanzó límite global USD ${maxBatch}`);
          break;
        }

        attempts = attempt;
        const inicio = new Date().toISOString();
        upsertManifestRow(manifestRows, {
          handle: contact.handle,
          nombre: contact.nombre,
          institución: contact.institución,
          cargo: contact.cargo,
          prioridad: contact.prioridad,
          tipo_extracción: tipo,
          actor_id: actorId,
          estado: STATES.RUNNING,
          intentos: attempts,
          inicio,
          error: '',
        });
        await persistManifest();

        try {
          const result = await runActorExtraction({
            client,
            tipo,
            handle: contact.handle,
            logger,
          });

          const cost = Number(result.costUsd);
          const costValue = Number.isFinite(cost) ? cost : 0;

          if (maxPerRun != null && costValue > maxPerRun + 1e-9) {
            upsertManifestRow(manifestRows, {
              handle: contact.handle,
              nombre: contact.nombre,
              institución: contact.institución,
              cargo: contact.cargo,
              prioridad: contact.prioridad,
              tipo_extracción: tipo,
              actor_id: actorId,
              estado: STATES.FAILED,
              intentos: attempts,
              run_id: result.runId,
              dataset_id: result.datasetId,
              inicio: result.startedAt || inicio,
              término: result.finishedAt || new Date().toISOString(),
              duración_segundos: result.durationSec,
              registros: result.recordCount,
              costo_usd: costValue,
              archivo_local: filePath,
              error: `cargo_usd ${costValue} supera límite por ejecución ${maxPerRun}`,
            });
            await persistManifest();
            state.accumulatedCost = Number((state.accumulatedCost + costValue).toFixed(6));
            requestStop(
              `cargo por ejecución ${costValue} USD supera APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN=${maxPerRun}`,
            );
            state.failed += 1;
            state.consecutiveNonTempFailures += 1;
            return;
          }

          const shape = validateActorResultShape(tipo, result.items);
          if (!shape.ok) {
            upsertManifestRow(manifestRows, {
              handle: contact.handle,
              nombre: contact.nombre,
              institución: contact.institución,
              cargo: contact.cargo,
              prioridad: contact.prioridad,
              tipo_extracción: tipo,
              actor_id: actorId,
              estado: STATES.FAILED,
              intentos: attempts,
              run_id: result.runId,
              dataset_id: result.datasetId,
              inicio: result.startedAt || inicio,
              término: result.finishedAt || new Date().toISOString(),
              duración_segundos: result.durationSec,
              registros: result.recordCount,
              costo_usd: costValue,
              archivo_local: filePath,
              error: shape.reason,
            });
            await persistManifest();
            state.accumulatedCost = Number((state.accumulatedCost + costValue).toFixed(6));
            requestStop(`resultados estructuralmente distintos (${tipo}): ${shape.reason}`);
            state.failed += 1;
            state.consecutiveNonTempFailures += 1;
            return;
          }

          const payload = {
            meta: {
              handle: contact.handle,
              nombre: contact.nombre,
              institución: contact.institución,
              cargo: contact.cargo,
              prioridad: contact.prioridad,
              url: contact.url,
              actor_id: result.actorId,
              run_id: result.runId,
              dataset_id: result.datasetId,
              extracted_at: result.finishedAt || new Date().toISOString(),
              cost_usd: Number.isFinite(cost) ? cost : result.costUsd,
              charged_events: result.charged,
              duration_seconds: result.durationSec,
              tipo_extracción: tipo,
            },
            input: {
              username: contact.handle,
            },
            items: result.items,
            run_snapshot: {
              id: result.runId,
              status: result.run.status,
              startedAt: result.run.startedAt,
              finishedAt: result.run.finishedAt,
              usageTotalUsd: result.run.usageTotalUsd ?? null,
              chargedEventCounts: result.run.chargedEventCounts ?? null,
              accountedChargedEventCounts: result.run.accountedChargedEventCounts ?? null,
              eventUsage: result.run.eventUsage ?? null,
              defaultDatasetId: result.datasetId,
            },
          };

          fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

          upsertManifestRow(manifestRows, {
            handle: contact.handle,
            nombre: contact.nombre,
            institución: contact.institución,
            cargo: contact.cargo,
            prioridad: contact.prioridad,
            tipo_extracción: tipo,
            actor_id: actorId,
            estado: STATES.SUCCEEDED,
            intentos: attempts,
            run_id: result.runId,
            dataset_id: result.datasetId,
            inicio: result.startedAt || inicio,
            término: result.finishedAt || new Date().toISOString(),
            duración_segundos: result.durationSec,
            registros: result.recordCount,
            costo_usd: Number.isFinite(cost) ? cost : (result.costUsd ?? ''),
            archivo_local: filePath,
            error: '',
          });
          await persistManifest();

          state.accumulatedCost = Number((state.accumulatedCost + costValue).toFixed(6));
          state.succeeded += 1;
          state.consecutiveNonTempFailures = 0;
          jobSucceeded = true;
          logger.info(
            `OK ${tipo} ${contact.handle}: registros=${result.recordCount} costo_usd=${costValue} acumulado_usd=${state.accumulatedCost}`,
          );

          if (state.accumulatedCost >= maxBatch) {
            requestStop(`costo acumulado alcanzó límite global USD ${maxBatch}`);
          }

          markContactProgress(contact.handle);
          break;
        } catch (error) {
          lastError = error;
          const message = redactSecrets(error.message || String(error));
          const nonRetryable = error.nonRetryable || isNonRetryableError(error);
          const authOrBalance = isAuthOrBalanceError(error);
          const failedCost = Number(error.costUsd);
          if (Number.isFinite(failedCost) && failedCost > 0) {
            state.accumulatedCost = Number((state.accumulatedCost + failedCost).toFixed(6));
          }

          upsertManifestRow(manifestRows, {
            handle: contact.handle,
            nombre: contact.nombre,
            institución: contact.institución,
            cargo: contact.cargo,
            prioridad: contact.prioridad,
            tipo_extracción: tipo,
            actor_id: actorId,
            estado: STATES.FAILED,
            intentos: attempts,
            run_id: error.run?.id || error.runId || '',
            dataset_id: error.datasetId || error.run?.defaultDatasetId || '',
            inicio,
            término: new Date().toISOString(),
            costo_usd: Number.isFinite(failedCost) ? failedCost : '',
            archivo_local: filePath,
            error: message,
          });
          await persistManifest();

          if (authOrBalance) {
            requestStop(`error de autenticación o saldo: ${message}`);
            state.failed += 1;
            state.consecutiveNonTempFailures += 1;
            return;
          }

          if (nonRetryable) {
            logger.error(`Fallo no reintentable ${tipo} ${contact.handle}: ${message}`);
            state.failed += 1;
            state.consecutiveNonTempFailures += 1;
            if (state.consecutiveNonTempFailures >= MAX_CONSECUTIVE_NON_TEMP_FAILURES) {
              requestStop(
                `${MAX_CONSECUTIVE_NON_TEMP_FAILURES} fallos consecutivos no temporales`,
              );
            }
            markContactProgress(contact.handle);
            break;
          }

          if (attempt <= MAX_RETRIES) {
            state.retries += 1;
            const wait = backoffMs(attempt);
            logger.warn(`Reintento ${attempt}/${MAX_RETRIES} en ${wait}ms para ${tipo} ${contact.handle}`);
            await sleep(wait);
          } else {
            logger.error(`Agotados reintentos ${tipo} ${contact.handle}: ${message}`);
            state.failed += 1;
            state.consecutiveNonTempFailures += 1;
            if (state.consecutiveNonTempFailures >= MAX_CONSECUTIVE_NON_TEMP_FAILURES) {
              requestStop(
                `${MAX_CONSECUTIVE_NON_TEMP_FAILURES} fallos consecutivos no temporales`,
              );
            }
            markContactProgress(contact.handle);
          }
        }
      }

      if (!jobSucceeded && lastError && !state.stopReason) {
        // already counted in failure branches
      }
    }
  });

  await Promise.all(workers);

  // Final checkpoint
  state.checkpointIndex += 1;
  const finalCheckpoint = writeCheckpoint({
    paths,
    checkpointIndex: state.checkpointIndex,
    contactsCompleted: state.contactsFullyDone.size,
    accumulatedCost: state.accumulatedCost,
    stopReason: state.stopReason,
    pendingRemaining: pending.length - state.succeeded - state.failed,
    succeeded: state.succeeded,
    failed: state.failed,
    skipped,
    consecutiveNonTempFailures: state.consecutiveNonTempFailures,
    logger,
  });
  state.checkpointFiles.push(finalCheckpoint);

  return {
    pending: pending.length,
    succeeded: state.succeeded,
    failed: state.failed,
    skipped,
    retries: state.retries,
    accumulated_cost_usd: state.accumulatedCost,
    batch_limit_usd: maxBatch,
    per_run_limit_usd: maxPerRun ?? null,
    stop_reason: state.stopReason,
    contacts_completed: state.contactsFullyDone.size,
    checkpoints: state.checkpointFiles,
    manifestPath: paths.manifestCsv,
  };
}

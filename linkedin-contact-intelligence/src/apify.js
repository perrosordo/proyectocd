import { ApifyClient } from 'apify-client';
import {
  ACTORS,
  NON_RETRYABLE_PATTERNS,
  POSTS_TOTAL_LIMIT,
  TERMINAL_RUN_STATUSES,
} from './constants.js';
import { getMaxTotalChargeUsdPerRun, getTokenPresence, redactSecrets } from './env.js';

export function createApifyClient() {
  if (!getTokenPresence()) {
    const err = new Error('APIFY_TOKEN no está disponible en el entorno cargado');
    err.code = 'TOKEN_MISSING';
    throw err;
  }
  return new ApifyClient({ token: process.env.APIFY_TOKEN });
}

export function buildActorInput(tipo, handle) {
  if (tipo === 'profile') {
    return {
      username: handle,
      includeEmail: false,
    };
  }
  if (tipo === 'posts') {
    return {
      username: handle,
      page_number: 1,
      total_posts: POSTS_TOTAL_LIMIT,
    };
  }
  throw new Error(`Tipo de extracción desconocido: ${tipo}`);
}

export async function confirmActors(client) {
  const results = {};
  for (const [key, meta] of Object.entries(ACTORS)) {
    try {
      const actor = await client.actor(meta.id).get();
      results[key] = {
        ok: Boolean(actor),
        id: meta.id,
        title: actor?.title || actor?.name || meta.id,
        username: actor?.username,
      };
    } catch (error) {
      results[key] = {
        ok: false,
        id: meta.id,
        error: redactSecrets(error.message || String(error)),
      };
    }
  }
  return results;
}

export function isNonRetryableError(error) {
  const message = redactSecrets(error?.message || String(error));
  const status = error?.statusCode || error?.status || error?.response?.statusCode;
  if (status === 401 || status === 403 || status === 402 || status === 404) return true;
  return NON_RETRYABLE_PATTERNS.some((re) => re.test(message));
}

export function isAuthOrBalanceError(error) {
  const message = redactSecrets(error?.message || String(error));
  const status = error?.statusCode || error?.status || error?.response?.statusCode;
  if (status === 401 || status === 403 || status === 402) return true;
  return [
    /invalid.*(token|api.?key|authentication|authorization)/i,
    /unauthorized/i,
    /authentication.?failed/i,
    /insufficient.*(credit|balance|fund|money)/i,
    /payment.?required/i,
    /not enough.*(credit|usage)/i,
  ].some((re) => re.test(message));
}

export function extractCostUsd(run) {
  if (!run || typeof run !== 'object') return null;

  if (run.eventUsage && typeof run.eventUsage === 'object') {
    let total = 0;
    let any = false;
    for (const info of Object.values(run.eventUsage)) {
      if (info?.eventTotalUsd != null && Number.isFinite(Number(info.eventTotalUsd))) {
        total += Number(info.eventTotalUsd);
        any = true;
      }
    }
    if (any) return total;
  }

  const candidates = [
    run.usageTotalUsd,
    run.chargedEventTotalCostUsd,
    run.usageUsd,
    run.stats?.costUsd,
    run.stats?.usageTotalUsd,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && Number.isFinite(Number(c))) {
      return Number(c);
    }
  }

  // Pay-per-event fallback from chargedEventCounts * known prices if present
  const counts = run.accountedChargedEventCounts || run.chargedEventCounts;
  if (counts && run.pricingInfo?.pricingPerEvent?.actorChargeEvents) {
    let total = 0;
    let any = false;
    const events = run.pricingInfo.pricingPerEvent.actorChargeEvents;
    for (const [eventKey, count] of Object.entries(counts)) {
      const price = events[eventKey]?.eventPriceUsd;
      if (price != null && Number.isFinite(Number(count))) {
        total += Number(price) * Number(count);
        any = true;
      }
    }
    if (any) return total;
  }
  return null;
}

export function extractChargedEvents(run) {
  if (!run) return null;
  return {
    chargedEventCounts: run.chargedEventCounts || null,
    accountedChargedEventCounts: run.accountedChargedEventCounts || null,
    eventUsage: run.eventUsage || null,
    usageTotalUsd: run.usageTotalUsd ?? null,
    pricingModel: run.pricingInfo?.pricingModel || null,
  };
}

async function refreshRunCost(client, runId, initialRun, { logger, attempts = 5, delayMs = 2000 } = {}) {
  let run = initialRun;
  for (let i = 0; i < attempts; i += 1) {
    const cost = extractCostUsd(run);
    const counts = run?.accountedChargedEventCounts || run?.chargedEventCounts || {};
    const chargedUnits = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
    if ((cost != null && cost > 0) || chargedUnits > 0 || i === attempts - 1) {
      return run;
    }
    logger?.info(`Esperando liquidación de cargos para run ${runId} (intento ${i + 1}/${attempts})`);
    await sleep(delayMs);
    run = await client.run(runId).get();
  }
  return run;
}

async function waitForTerminal(client, runId, { pollMs = 3000, logger } = {}) {
  while (true) {
    const run = await client.run(runId).get();
    if (!run) throw new Error(`No se pudo consultar la ejecución ${runId}`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return run;
    }
    logger?.info(`Esperando run ${runId} estado=${run.status}`);
    await sleep(pollMs);
  }
}

async function listAllDatasetItems(client, datasetId) {
  const items = [];
  let offset = 0;
  const limit = 250;
  while (true) {
    const page = await client.dataset(datasetId).listItems({ offset, limit });
    const batch = page.items || [];
    items.push(...batch);
    if (batch.length < limit) break;
    offset += batch.length;
  }
  return items;
}

/**
 * Async extraction flow:
 * start -> save run_id -> poll -> terminal -> download dataset
 */
export async function runActorExtraction({
  client,
  tipo,
  handle,
  logger,
}) {
  const actorMeta = ACTORS[tipo];
  if (!actorMeta) throw new Error(`Actor no configurado para tipo ${tipo}`);

  const input = buildActorInput(tipo, handle);
  const maxTotalChargeUsd = getMaxTotalChargeUsdPerRun();
  const startOptions = {};
  if (maxTotalChargeUsd !== undefined) {
    startOptions.maxTotalChargeUsd = maxTotalChargeUsd;
  }

  const started = await client.actor(actorMeta.id).start(input, startOptions);
  const runId = started.id;
  logger?.info(`Iniciado ${actorMeta.id} run_id=${runId} handle=${handle}`);

  let run = await waitForTerminal(client, runId, { logger });
  const datasetId = run.defaultDatasetId || '';
  let items = [];
  if (datasetId && run.status === 'SUCCEEDED') {
    items = await listAllDatasetItems(client, datasetId);
  }

  // Pay-per-event charges can settle shortly after terminal status.
  run = await refreshRunCost(client, runId, run, { logger });

  const costUsd = extractCostUsd(run);
  const charged = extractChargedEvents(run);
  const startedAt = run.startedAt ? new Date(run.startedAt) : null;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  let durationSec = '';
  if (startedAt && finishedAt) {
    durationSec = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  }

  if (run.status !== 'SUCCEEDED') {
    const err = new Error(`Run ${runId} terminó en estado ${run.status}`);
    err.code = 'RUN_FAILED';
    err.run = run;
    err.costUsd = costUsd;
    err.charged = charged;
    err.datasetId = datasetId;
    err.nonRetryable = run.status === 'ABORTED' && /charge|budget|limit/i.test(run.statusMessage || '');
    throw err;
  }

  return {
    actorId: actorMeta.id,
    runId,
    datasetId,
    items,
    run,
    costUsd,
    charged,
    startedAt: startedAt ? startedAt.toISOString() : '',
    finishedAt: finishedAt ? finishedAt.toISOString() : '',
    durationSec,
    recordCount: countLogicalRecords(tipo, items),
  };
}

export function countLogicalRecords(tipo, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  if (tipo === 'profile') return items.length;
  // Posts actor often returns one wrapper object with data.posts[]
  let total = 0;
  for (const item of items) {
    const message = String(item?.message || item?.error || '');
    if (/no posts found/i.test(message)) continue;
    const posts = item?.data?.posts || item?.posts;
    if (Array.isArray(posts)) total += posts.length;
    else if (item?.full_urn || item?.urn || item?.url || item?.text != null || item?.posted_at) {
      total += 1;
    }
  }
  return total;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffMs(attempt) {
  // attempt 1 => 2s, 2 => 4s
  return Math.min(30000, 1000 * 2 ** attempt);
}

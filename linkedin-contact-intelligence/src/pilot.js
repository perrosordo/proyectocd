import fs from 'node:fs';
import path from 'node:path';
import { PILOT_NAME_MATCH } from './constants.js';
import { consolidateAll } from './consolidate.js';
import { loadExternalEnv } from './env.js';
import { extractContacts } from './extract.js';
import { loadContacts, validateContacts } from './excel.js';
import { createLogger } from './logger.js';
import { ensureOutputDirs, getOutputPaths, postsRawPath, profileRawPath, PROJECT_ROOT, sanitizeFilename } from './paths.js';

function findPilotContact(contacts) {
  const byName = contacts.find((c) => PILOT_NAME_MATCH.test(c.nombre || ''));
  if (byName) return byName;
  const byHandle = contacts.find((c) =>
    /mar[ií]a-consuelo-macari/i.test(c.handle || ''),
  );
  return byHandle || null;
}

function readCostFromRaw(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      cost_usd: raw.meta?.cost_usd ?? null,
      registros: Array.isArray(raw.items)
        ? (raw.meta?.tipo_extracción === 'posts'
          ? (raw.items[0]?.data?.posts?.length
            ?? raw.items.reduce((n, it) => n + (it?.data?.posts?.length || it?.posts?.length || 1), 0))
          : raw.items.length)
        : 0,
      duration_seconds: raw.meta?.duration_seconds ?? null,
      run_id: raw.meta?.run_id || '',
      charged_events: raw.meta?.charged_events || null,
    };
  } catch {
    return null;
  }
}

function findPreviousDownloads(handle) {
  const candidates = [
    path.resolve(PROJECT_ROOT, '..', 'data download'),
    path.resolve(PROJECT_ROOT, '..', '..', 'data download'),
  ];
  const hits = [];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    // Only shallow/known subfolders — do not scan for credentials
    const walkLimited = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === '.env' || e.name.startsWith('.env')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkLimited(full, depth + 1);
        else if (e.name.toLowerCase().includes(handle.toLowerCase().slice(0, 20)) && e.name.endsWith('.json')) {
          hits.push(full);
        }
      }
    };
    walkLimited(root, 0);
  }
  return hits;
}

export async function runPilot({
  inputPath,
  envFileFlag,
  force = false,
  profilesOnly = false,
  postsOnly = false,
  projectRoot = PROJECT_ROOT,
}) {
  const paths = getOutputPaths(projectRoot);
  ensureOutputDirs(paths);
  const logger = createLogger(paths.logs, 'pilot');

  loadExternalEnv({ envFileFlag, projectRoot });
  const { contacts } = loadContacts(inputPath);
  const validation = validateContacts(contacts);
  const pilot = findPilotContact(validation.uniqueContacts);
  if (!pilot) {
    throw new Error('No se encontró el contacto piloto María Consuelo Macari en el Excel');
  }

  logger.info(`Piloto: ${pilot.nombre} handle=${pilot.handle}`);

  const started = Date.now();
  const result = await extractContacts({
    contacts: [pilot],
    logger,
    force,
    concurrency: 1,
    profilesOnly,
    postsOnly,
    projectRoot,
  });

  const safe = sanitizeFilename(pilot.handle);
  const profileFile = profileRawPath(paths, safe);
  const postsFile = postsRawPath(paths, safe);
  const profileStats = readCostFromRaw(profileFile);
  const postsStats = readCostFromRaw(postsFile);

  const profileCost = profileStats?.cost_usd;
  const postsCost = postsStats?.cost_usd;
  const totalCost = [profileCost, postsCost]
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .reduce((a, b) => a + Number(b), 0);

  consolidateAll({ contacts: [pilot], logger, projectRoot });

  const previous = findPreviousDownloads(pilot.handle);
  let previousCompare = null;
  if (previous.length) {
    previousCompare = { previous_files: previous, note: 'Archivos previos detectados para comparación manual' };
    logger.info(`Descargas previas encontradas: ${previous.length}`);
  }

  const elapsedSec = Math.round((Date.now() - started) / 1000);
  const projection55 = {
    profile_unit_usd: profileCost,
    posts_unit_usd: postsCost,
    contact_total_usd: Number.isFinite(totalCost) ? totalCost : null,
    projected_55_contacts_usd:
      Number.isFinite(totalCost) ? Number((totalCost * 55).toFixed(4)) : null,
    note: 'Proyección lineal a partir del piloto; el costo de posts depende de publicaciones reales por perfil.',
  };

  console.log('\n=== PILOTO María Consuelo Macari ===');
  console.log(`Handle: ${pilot.handle}`);
  console.log(`Perfil: registros=${profileStats?.registros ?? 'n/d'} duración_s=${profileStats?.duration_seconds ?? 'n/d'} costo_usd=${profileCost ?? 'n/d'}`);
  console.log(`Posts: registros=${postsStats?.registros ?? 'n/d'} duración_s=${postsStats?.duration_seconds ?? 'n/d'} costo_usd=${postsCost ?? 'n/d'}`);
  console.log(`Costo total contacto: ${Number.isFinite(totalCost) ? totalCost : 'n/d'} USD`);
  console.log(`Duración wall-clock piloto: ${elapsedSec}s`);
  console.log(`Proyección 55 contactos: ${projection55.projected_55_contacts_usd ?? 'n/d'} USD`);
  if (previous.length) {
    console.log(`Comparación: ${previous.length} archivo(s) previo(s) en data download`);
  }

  return {
    pilot,
    extract: result,
    profileStats,
    postsStats,
    totalCost: Number.isFinite(totalCost) ? totalCost : null,
    elapsedSec,
    projection55,
    previousCompare,
  };
}

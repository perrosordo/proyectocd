import { ACTORS } from './constants.js';
import { confirmActors, createApifyClient } from './apify.js';
import { loadExternalEnv, getTokenPresence } from './env.js';
import { loadContacts, validateContacts } from './excel.js';
import { createLogger } from './logger.js';
import { ensureOutputDirs, getOutputPaths, PROJECT_ROOT } from './paths.js';

export async function runDryRun({ inputPath, envFileFlag, projectRoot = PROJECT_ROOT }) {
  const paths = getOutputPaths(projectRoot);
  ensureOutputDirs(paths);
  const logger = createLogger(paths.logs, 'dry-run');

  logger.info(`Entrada: ${inputPath}`);
  const { contacts, sheetName, inputPath: resolvedInput } = loadContacts(inputPath);
  const validation = validateContacts(contacts);

  let envInfo = { envPath: null, tokenPresent: false };
  try {
    envInfo = loadExternalEnv({ envFileFlag, projectRoot });
  } catch (error) {
    logger.warn(error.message);
  }

  const tokenOk = getTokenPresence();
  let actorStatus = null;
  if (tokenOk) {
    const client = createApifyClient();
    actorStatus = await confirmActors(client);
  }

  const plannedRuns = validation.uniqueContacts.length * 2;

  const report = {
    input: resolvedInput,
    sheet: sheetName,
    contacts_total: validation.total,
    unique_handles: validation.uniqueHandleCount,
    invalid_urls: validation.issues.invalidUrls.map((c) => ({
      row: c.rowNumber,
      nombre: c.nombre,
      url: c.url_raw,
    })),
    missing_names: validation.issues.missingNames.map((c) => c.rowNumber),
    duplicates: validation.issues.duplicates,
    env_file_resolved: envInfo.envPath,
    token_present: tokenOk,
    actors: {
      profile: ACTORS.profile.id,
      posts: ACTORS.posts.id,
      confirmation: actorStatus,
    },
    planned_actor_runs: plannedRuns,
    note: 'dry-run no inicia actores',
  };

  console.log('\n=== DRY-RUN ===');
  console.log(`Contactos leídos: ${report.contacts_total}`);
  console.log(`Handles únicos: ${report.unique_handles}`);
  console.log(`URL inválidas: ${report.invalid_urls.length}`);
  console.log(`Duplicados de handle: ${report.duplicates.length}`);
  console.log(`Token Apify presente: ${report.token_present ? 'sí' : 'no'} (no se muestra)`);
  console.log(`Env file: ${report.env_file_resolved || '(no resuelto)'}`);
  console.log(`Actor perfil: ${ACTORS.profile.id}`);
  console.log(`Actor posts: ${ACTORS.posts.id}`);
  if (actorStatus) {
    for (const [k, v] of Object.entries(actorStatus)) {
      console.log(`  Confirmación ${k}: ${v.ok ? 'OK' : `FALLO (${v.error || 'n/d'})`}`);
    }
  } else {
    console.log('  Confirmación actores: omitida (sin token)');
  }
  console.log(`Ejecuciones que se realizarían: ${plannedRuns} (2 por contacto único)`);
  console.log('Ningún actor fue iniciado.');

  if (report.invalid_urls.length) {
    console.log('\nURL inválidas:');
    for (const u of report.invalid_urls) {
      console.log(`  fila ${u.row}: ${u.nombre} -> ${u.url || '(vacío)'}`);
    }
  }
  if (report.duplicates.length) {
    console.log('\nDuplicados:');
    for (const d of report.duplicates) {
      console.log(`  ${d.handle} filas=${d.rows.join(',')}`);
    }
  }

  logger.info('Dry-run completado', {
    contacts_total: report.contacts_total,
    unique_handles: report.unique_handles,
    planned_actor_runs: plannedRuns,
    token_present: tokenOk,
  });

  return report;
}

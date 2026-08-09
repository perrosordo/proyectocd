#!/usr/bin/env node
import { asBoolean, asNumber, parseArgs } from './args.js';
import { DEFAULT_CONCURRENCY } from './constants.js';
import { consolidateAll, validateJsonTree } from './consolidate.js';
import { runDryRun } from './dry-run.js';
import { loadExternalEnv, redactSecrets } from './env.js';
import { extractContacts } from './extract.js';
import { loadContacts, validateContacts } from './excel.js';
import { createLogger } from './logger.js';
import { runPilot } from './pilot.js';
import { ensureOutputDirs, getOutputPaths, PROJECT_ROOT } from './paths.js';
import { runStatus } from './status.js';
import { downloadProfilePhotos } from './download-photos.js';
import fs from 'node:fs';

const DEFAULT_INPUT =
  'C:\\Users\\iloyo\\Downloads\\contactos_linkedin_educacion_superior_55 (1).xlsx';

function printUsage() {
  console.log(`Uso:
  npm run dry-run -- [--input path] [--env-file path]
  npm run pilot -- [--input path] [--env-file path] [--force] [--profiles-only] [--posts-only]
  npm run extract -- [--input path] [--env-file path] [--concurrency N] [--force] [--profiles-only] [--posts-only] [--profile handle]
  npm run consolidate -- [--input path]
  npm run status -- [--input path]
  npm run download-photos -- [--force] [--concurrency N]

También: APIFY_ENV_PATH=/ruta/al/.env
Límite por run: APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN=<usd>
Límite global de lote (default 30): APIFY_MAX_TOTAL_CHARGE_USD_BATCH=<usd>
`);
}

async function main() {
  const { command, flags } = parseArgs();
  if (!command || flags.help || flags.h) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const inputPath = flags.input || DEFAULT_INPUT;
  const envFileFlag = flags['env-file'] || flags.envFile;
  const force = asBoolean(flags.force, false);
  const profilesOnly = asBoolean(flags['profiles-only'] || flags.profilesOnly, false);
  const postsOnly = asBoolean(flags['posts-only'] || flags.postsOnly, false);
  const concurrency = asNumber(flags.concurrency, DEFAULT_CONCURRENCY);
  const profileFilterValue = flags.profile ? String(flags.profile) : null;
  const projectRoot = PROJECT_ROOT;
  const paths = getOutputPaths(projectRoot);
  ensureOutputDirs(paths);

  try {
    switch (command) {
      case 'dry-run': {
        await runDryRun({ inputPath, envFileFlag, projectRoot });
        break;
      }
      case 'pilot': {
        await runPilot({
          inputPath,
          envFileFlag,
          force,
          profilesOnly,
          postsOnly,
          projectRoot,
        });
        break;
      }
      case 'extract': {
        const logger = createLogger(paths.logs, 'extract');
        loadExternalEnv({ envFileFlag, projectRoot });
        const { contacts } = loadContacts(inputPath);
        const validation = validateContacts(contacts);
        const filter = profileFilterValue
          ? (c) => c.handle === profileFilterValue || c.handle?.toLocaleLowerCase('es') === profileFilterValue.toLocaleLowerCase('es')
          : null;
        const result = await extractContacts({
          contacts: validation.uniqueContacts,
          logger,
          force,
          concurrency,
          profilesOnly,
          postsOnly,
          profileFilter: filter,
          projectRoot,
        });
        console.log('\n=== EXTRACT ===');
        console.log(JSON.stringify(result, null, 2));
        if (result.stop_reason) {
          console.log(`\nDetenido por: ${result.stop_reason}`);
        }
        break;
      }
      case 'consolidate': {
        const logger = createLogger(paths.logs, 'consolidate');
        const { contacts } = loadContacts(inputPath);
        const validation = validateContacts(contacts);
        const summary = consolidateAll({
          contacts: validation.uniqueContacts,
          logger,
          projectRoot,
        });
        const jsonProblems = [
          ...validateJsonTree(paths.rawProfiles),
          ...validateJsonTree(paths.rawPosts),
          ...validateJsonTree(paths.consolidated),
        ];
        console.log('\n=== CONSOLIDATE ===');
        console.log(`Handles únicos: ${summary.unique_handles}`);
        console.log(`Perfiles: ${summary.profiles_consolidated}`);
        console.log(`Publicaciones: ${summary.posts_consolidated}`);
        console.log(`Posts huérfanos (sin perfil): ${summary.orphan_posts}`);
        console.log(`JSON inválidos: ${jsonProblems.length}`);
        if (jsonProblems.length) {
          for (const p of jsonProblems) console.log(`  ${p.file}: ${p.error}`);
        }
        break;
      }
      case 'status': {
        runStatus({ inputPath, projectRoot });
        break;
      }
      case 'download-photos': {
        const logger = createLogger(paths.logs, 'download-photos');
        if (!fs.existsSync(paths.profilesConsolidated)) {
          throw new Error(
            `No existe ${paths.profilesConsolidated}. Ejecuta primero npm run consolidate.`,
          );
        }
        const profiles = JSON.parse(fs.readFileSync(paths.profilesConsolidated, 'utf8'));
        const report = await downloadProfilePhotos({
          profiles,
          photosDir: paths.profilePhotos,
          manifestPath: paths.photosManifest,
          concurrency: asNumber(flags.concurrency, 5),
          force,
          logger,
        });
        console.log('\n=== DOWNLOAD PHOTOS ===');
        console.log(`Total perfiles: ${report.total}`);
        console.log(`Con URL: ${report.with_url}`);
        console.log(`Sin URL: ${report.without_url}`);
        console.log(`Descargadas: ${report.downloaded}`);
        console.log(`Omitidas: ${report.skipped}`);
        console.log(`Fallidas: ${report.failed}`);
        console.log(`Carpeta: ${report.photos_dir}`);
        console.log(`Manifiesto: ${paths.photosManifest}`);
        break;
      }
      default:
        console.error(`Comando desconocido: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${redactSecrets(error.message || String(error))}`);
    process.exit(1);
  }
}

main();

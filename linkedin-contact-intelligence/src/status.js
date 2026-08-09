import fs from 'node:fs';
import { STATES } from './constants.js';
import { isValidRawJson } from './extract.js';
import { loadContacts, validateContacts } from './excel.js';
import { loadManifest } from './manifest.js';
import {
  getOutputPaths,
  postsRawPath,
  profileRawPath,
  PROJECT_ROOT,
  sanitizeFilename,
} from './paths.js';

export function runStatus({ inputPath, projectRoot = PROJECT_ROOT }) {
  const paths = getOutputPaths(projectRoot);
  const { contacts } = loadContacts(inputPath);
  const validation = validateContacts(contacts);
  const manifest = loadManifest(paths.manifestCsv);

  const summary = {
    pending: [],
    succeeded: [],
    failed: [],
    skipped: [],
    running: [],
    missing_manifest: [],
  };

  for (const contact of validation.uniqueContacts) {
    for (const tipo of ['profile', 'posts']) {
      const row = manifest.find((r) => r.handle === contact.handle && r.tipo_extracción === tipo);
      const file = tipo === 'profile'
        ? profileRawPath(paths, sanitizeFilename(contact.handle))
        : postsRawPath(paths, sanitizeFilename(contact.handle));
      const rawOk = isValidRawJson(file);
      const estado = row?.estado || (rawOk ? STATES.SUCCEEDED : STATES.PENDING);
      const entry = {
        handle: contact.handle,
        nombre: contact.nombre,
        tipo,
        estado,
        run_id: row?.run_id || '',
        registros: row?.registros || '',
        costo_usd: row?.costo_usd || '',
        error: row?.error || '',
        raw_ok: rawOk,
      };
      if (!row && !rawOk) summary.missing_manifest.push(entry);
      if (estado === STATES.SUCCEEDED || (rawOk && estado !== STATES.FAILED)) summary.succeeded.push(entry);
      else if (estado === STATES.FAILED) summary.failed.push(entry);
      else if (estado === STATES.RUNNING) summary.running.push(entry);
      else if (estado === STATES.SKIPPED) summary.skipped.push(entry);
      else summary.pending.push(entry);
    }
  }

  console.log('\n=== STATUS ===');
  console.log(`Contactos únicos: ${validation.uniqueHandleCount}`);
  console.log(`Succeeded: ${summary.succeeded.length}`);
  console.log(`Pending: ${summary.pending.length}`);
  console.log(`Failed: ${summary.failed.length}`);
  console.log(`Running: ${summary.running.length}`);
  console.log(`Skipped: ${summary.skipped.length}`);
  console.log(`Sin manifiesto/raw: ${summary.missing_manifest.length}`);

  if (summary.failed.length) {
    console.log('\nFallidos:');
    for (const f of summary.failed) {
      console.log(`  ${f.tipo} ${f.handle}: ${f.error}`);
    }
  }

  return {
    unique_handles: validation.uniqueHandleCount,
    counts: {
      succeeded: summary.succeeded.length,
      pending: summary.pending.length,
      failed: summary.failed.length,
      running: summary.running.length,
      skipped: summary.skipped.length,
    },
    summary,
    manifest_exists: fs.existsSync(paths.manifestCsv),
  };
}

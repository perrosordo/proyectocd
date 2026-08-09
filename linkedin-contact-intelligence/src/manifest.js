import fs from 'node:fs';
import { MANIFEST_COLUMNS, STATES } from './constants.js';

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToObject(values) {
  const obj = {};
  MANIFEST_COLUMNS.forEach((col, i) => {
    obj[col] = values[i] ?? '';
  });
  return obj;
}

export function emptyManifestRow(contact, tipo, actorId) {
  return {
    handle: contact.handle || '',
    nombre: contact.nombre || '',
    institución: contact.institución || '',
    cargo: contact.cargo || '',
    prioridad: contact.prioridad || '',
    tipo_extracción: tipo,
    actor_id: actorId,
    estado: STATES.PENDING,
    intentos: 0,
    run_id: '',
    dataset_id: '',
    inicio: '',
    término: '',
    duración_segundos: '',
    registros: '',
    costo_usd: '',
    archivo_local: '',
    error: '',
  };
}

export function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  const text = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return [];

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= 1) return [];

  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const mapped = {};
    header.forEach((col, i) => {
      mapped[col] = values[i] ?? '';
    });
    // Ensure all expected columns exist
    for (const col of MANIFEST_COLUMNS) {
      if (mapped[col] === undefined) mapped[col] = '';
    }
    rows.push(mapped);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

export function saveManifest(manifestPath, rows) {
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(MANIFEST_COLUMNS.map((col) => escapeCsv(row[col] ?? '')).join(','));
  }
  fs.mkdirSync(manifestPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`, 'utf8');
}

export function upsertManifestRow(rows, nextRow) {
  const idx = rows.findIndex(
    (r) => r.handle === nextRow.handle && r.tipo_extracción === nextRow.tipo_extracción,
  );
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...nextRow };
  } else {
    rows.push({ ...nextRow });
  }
  return rows;
}

export function findManifestRow(rows, handle, tipo) {
  return rows.find((r) => r.handle === handle && r.tipo_extracción === tipo) || null;
}

export function ensureManifestForContacts(rows, contacts, actors) {
  for (const contact of contacts) {
    if (!contact.handle) continue;
    for (const tipo of ['profile', 'posts']) {
      const actorId = actors[tipo].id;
      if (!findManifestRow(rows, contact.handle, tipo)) {
        rows.push(emptyManifestRow(contact, tipo, actorId));
      }
    }
  }
  return rows;
}

export { rowToObject };

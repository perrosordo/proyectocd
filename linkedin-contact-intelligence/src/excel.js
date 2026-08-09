import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { buildCanonicalProfileUrl, normalizeHandle } from './handles.js';

const COLUMN_ALIASES = {
  nombre: ['nombre', 'name', 'contacto'],
  institución: ['institución', 'institucion', 'institution', 'universidad'],
  cargo: ['cargo', 'role', 'puesto', 'title'],
  prioridad: ['prioridad', 'priority'],
  url: ['url linkedin', 'url', 'linkedin', 'linkedin url', 'perfil'],
  handle: ['handle', 'username', 'slug'],
};

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function mapHeaders(headers) {
  const mapping = {};
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const aliasNorms = aliases.map((a) => normalizeHeader(a));
    const hit = normalized.find((h) => aliasNorms.includes(h.norm));
    if (hit) mapping[field] = hit.raw;
  }
  return mapping;
}

function scoreHeaderRow(cells) {
  const mapping = mapHeaders(cells.map((c) => String(c ?? '')));
  return Object.keys(mapping).length;
}

export function loadContacts(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Archivo de entrada no encontrado: ${resolved}`);
  }

  const workbook = XLSX.readFile(resolved, { cellDates: true });
  const sheetName = workbook.SheetNames.find((n) => normalizeHeader(n) === 'contactos')
    || workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('El Excel no contiene hojas');
  }

  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!matrix.length) {
    throw new Error(`La hoja "${sheetName}" no tiene filas`);
  }

  let headerIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(matrix.length, 30); i += 1) {
    const score = scoreHeaderRow(matrix[i] || []);
    if (score > bestScore) {
      bestScore = score;
      headerIdx = i;
    }
  }

  if (headerIdx < 0 || bestScore < 3) {
    throw new Error(
      `No se encontró fila de encabezados válida en "${sheetName}". Se esperaban Nombre, Institución, Cargo, URL LinkedIn, Handle.`,
    );
  }

  const headers = (matrix[headerIdx] || []).map((h) => String(h ?? '').trim());
  const mapping = mapHeaders(headers);
  if (!mapping.nombre || (!mapping.url && !mapping.handle)) {
    throw new Error(
      `No se reconocieron columnas esperadas en "${sheetName}". Encabezados: ${headers.join(', ')}`,
    );
  }

  const contacts = [];
  for (let r = headerIdx + 1; r < matrix.length; r += 1) {
    const cells = matrix[r] || [];
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });

    const nombre = String(row[mapping.nombre] ?? '').trim();
    const institución = String(row[mapping.institución] ?? '').trim();
    const cargo = String(row[mapping.cargo] ?? '').trim();
    const prioridad = String(row[mapping.prioridad] ?? '').trim();
    const urlRaw = String(row[mapping.url] ?? '').trim();
    const handleRaw = String(row[mapping.handle] ?? '').trim();

    // Skip empty trailing rows
    if (!nombre && !urlRaw && !handleRaw) continue;

    const handleFromUrl = normalizeHandle(urlRaw);
    const handleFromField = normalizeHandle(handleRaw);
    const handle = handleFromUrl || handleFromField;
    const url = urlRaw || buildCanonicalProfileUrl(handle);

    contacts.push({
      rowNumber: r + 1,
      nombre,
      institución,
      cargo,
      prioridad,
      url_raw: urlRaw,
      handle_raw: handleRaw,
      handle,
      url,
      url_invalid: !handle,
    });
  }

  return {
    inputPath: resolved,
    sheetName,
    contacts,
    mapping,
    headerRow: headerIdx + 1,
  };
}

export function validateContacts(contacts) {
  const issues = {
    invalidUrls: [],
    missingNames: [],
    duplicates: [],
  };

  const byHandle = new Map();
  for (const c of contacts) {
    if (!c.nombre) issues.missingNames.push(c);
    if (!c.handle || c.url_invalid) {
      issues.invalidUrls.push(c);
      continue;
    }
    const key = c.handle.toLocaleLowerCase('es');
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key).push(c);
  }

  for (const [key, group] of byHandle.entries()) {
    if (group.length > 1) {
      issues.duplicates.push({ handle: group[0].handle, key, rows: group.map((g) => g.rowNumber) });
    }
  }

  return {
    total: contacts.length,
    uniqueHandleCount: byHandle.size,
    issues,
    uniqueContacts: [...byHandle.values()].map((g) => g[0]),
  };
}

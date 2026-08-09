import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Resolve external .env path without scanning the disk for credentials.
 * Priority: --env-file > APIFY_ENV_PATH > ./../data download/.env (only if present)
 */
export function resolveEnvFilePath({ envFileFlag, projectRoot }) {
  if (envFileFlag) {
    return path.resolve(String(envFileFlag));
  }

  if (process.env.APIFY_ENV_PATH) {
    return path.resolve(process.env.APIFY_ENV_PATH);
  }

  const siblingCandidates = [
    path.resolve(projectRoot, '..', 'data download', '.env'),
    path.resolve(projectRoot, '..', '..', 'data download', '.env'),
  ];

  for (const candidate of siblingCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function loadExternalEnv({ envFileFlag, projectRoot }) {
  const envPath = resolveEnvFilePath({ envFileFlag, projectRoot });
  if (!envPath) {
    const err = new Error(
      'No se encontró el archivo .env externo. Indica la ruta con --env-file o APIFY_ENV_PATH. ' +
        'No se busca el token en todo el disco.',
    );
    err.code = 'ENV_NOT_FOUND';
    throw err;
  }

  if (!fs.existsSync(envPath)) {
    const err = new Error(`El archivo .env indicado no existe: ${envPath}`);
    err.code = 'ENV_NOT_FOUND';
    throw err;
  }

  const result = dotenv.config({ path: envPath, override: false });
  if (result.error) {
    throw result.error;
  }

  const tokenPresent = Boolean(process.env.APIFY_TOKEN && String(process.env.APIFY_TOKEN).trim());
  return {
    envPath,
    tokenPresent,
  };
}

export function getTokenPresence() {
  return Boolean(process.env.APIFY_TOKEN && String(process.env.APIFY_TOKEN).trim());
}

export function getMaxTotalChargeUsdPerRun() {
  const raw = process.env.APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN debe ser un número >= 0');
  }
  return value;
}

/**
 * Global accumulated charge limit for a full extract batch.
 * Default 30 USD unless APIFY_MAX_TOTAL_CHARGE_USD_BATCH is set.
 */
export function getMaxTotalChargeUsdBatch(defaultValue = 30) {
  const raw = process.env.APIFY_MAX_TOTAL_CHARGE_USD_BATCH;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('APIFY_MAX_TOTAL_CHARGE_USD_BATCH debe ser un número >= 0');
  }
  return value;
}

/** Redact any accidental token leakage from strings before logging. */
export function redactSecrets(text) {
  if (text == null) return text;
  let out = String(text);
  const token = process.env.APIFY_TOKEN;
  if (token && token.length > 6) {
    out = out.split(token).join('[REDACTED]');
  }
  out = out.replace(/apify_api_[A-Za-z0-9]+/g, '[REDACTED]');
  return out;
}

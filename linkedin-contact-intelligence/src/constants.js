export const ACTORS = {
  profile: {
    id: 'apimaestro/linkedin-profile-detail',
    httpId: 'apimaestro~linkedin-profile-detail',
    type: 'profile',
  },
  posts: {
    id: 'apimaestro/linkedin-profile-posts',
    httpId: 'apimaestro~linkedin-profile-posts',
    type: 'posts',
  },
};

export const MANIFEST_COLUMNS = [
  'handle',
  'nombre',
  'institución',
  'cargo',
  'prioridad',
  'tipo_extracción',
  'actor_id',
  'estado',
  'intentos',
  'run_id',
  'dataset_id',
  'inicio',
  'término',
  'duración_segundos',
  'registros',
  'costo_usd',
  'archivo_local',
  'error',
];

export const STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

export const TERMINAL_RUN_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
  'TIMED-OUT',
]);

export const MAX_RETRIES = 2;
export const DEFAULT_CONCURRENCY = 3;
export const POSTS_TOTAL_LIMIT = 100;
export const PILOT_NAME_MATCH = /mar[ií]a\s+consuelo\s+macari/i;
export const DEFAULT_BATCH_MAX_TOTAL_CHARGE_USD = 30;
export const CHECKPOINT_EVERY_CONTACTS = 10;
export const MAX_CONSECUTIVE_NON_TEMP_FAILURES = 3;

export const NON_RETRYABLE_PATTERNS = [
  /invalid.*(token|api.?key|authentication|authorization)/i,
  /unauthorized/i,
  /authentication.?failed/i,
  /insufficient.*(credit|balance|fund|money)/i,
  /payment.?required/i,
  /actor.*(not.?found|does.?not.?exist)/i,
  /input.*(invalid|rejected|validation)/i,
  /max.?total.?charge/i,
  /charge.?limit/i,
  /budget.?limit/i,
];

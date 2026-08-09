import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');

export function getOutputPaths(root = PROJECT_ROOT) {
  return {
    root,
    output: path.join(root, 'output'),
    rawProfiles: path.join(root, 'output', 'raw', 'profiles'),
    rawPosts: path.join(root, 'output', 'raw', 'posts'),
    consolidated: path.join(root, 'output', 'consolidated'),
    manifests: path.join(root, 'output', 'manifests'),
    logs: path.join(root, 'output', 'logs'),
    manifestCsv: path.join(root, 'output', 'manifests', 'extraction_manifest.csv'),
    profilesConsolidated: path.join(root, 'output', 'consolidated', 'linkedin_profiles_consolidated.json'),
    postsConsolidated: path.join(root, 'output', 'consolidated', 'linkedin_posts_consolidated.json'),
    postsNdjson: path.join(root, 'output', 'consolidated', 'linkedin_posts_consolidated.ndjson'),
    postsFlatCsv: path.join(root, 'output', 'consolidated', 'linkedin_posts_flat.csv'),
    contactIntelligence: path.join(root, 'output', 'consolidated', 'contact_intelligence_dataset.json'),
    coverageSummary: path.join(root, 'output', 'consolidated', 'coverage_summary.json'),
    checkpoints: path.join(root, 'output', 'manifests', 'checkpoints'),
    media: path.join(root, 'output', 'media'),
    profilePhotos: path.join(root, 'output', 'media', 'profile_photos'),
    photosManifest: path.join(root, 'output', 'manifests', 'profile_photos_manifest.json'),
  };
}

export function ensureOutputDirs(paths) {
  for (const dir of [
    paths.output,
    paths.rawProfiles,
    paths.rawPosts,
    paths.consolidated,
    paths.manifests,
    paths.logs,
    paths.media,
    paths.profilePhotos,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function profileRawPath(paths, handle) {
  return path.join(paths.rawProfiles, `${handle}.json`);
}

export function postsRawPath(paths, handle) {
  return path.join(paths.rawPosts, `${handle}.json`);
}

/** Safe filename for Windows while preserving Unicode handle characters. */
export function sanitizeFilename(handle) {
  return String(handle).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFilename } from './paths.js';

function extensionFromContentType(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return '.jpg';
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('image/gif')) return '.gif';
  const fromUrl = url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  if (fromUrl) return `.${fromUrl[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.jpg';
}

async function mapPool(items, concurrency, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

function profilePictureUrl(profile) {
  const item = Array.isArray(profile.datos_apify)
    ? profile.datos_apify[0]
    : profile.datos_apify;
  return String(item?.basic_info?.profile_picture_url || '').trim();
}

export async function downloadProfilePhotos({
  profiles,
  photosDir,
  manifestPath,
  concurrency = 5,
  force = false,
  logger,
}) {
  fs.mkdirSync(photosDir, { recursive: true });

  const jobs = profiles.map((profile) => ({
    handle: profile.handle,
    nombre: profile.nombre,
    url: profilePictureUrl(profile),
  }));

  const summary = {
    total: jobs.length,
    with_url: 0,
    without_url: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  await mapPool(jobs, concurrency, async (job) => {
    const base = sanitizeFilename(job.handle || 'unknown');
    if (!job.url) {
      summary.without_url += 1;
      summary.items.push({
        handle: job.handle,
        nombre: job.nombre,
        estado: 'missing_url',
        source_url: '',
        archivo_local: '',
        error: 'sin profile_picture_url',
      });
      logger?.info(`Sin foto: ${job.handle}`);
      return;
    }

    summary.with_url += 1;

    // Skip if any extension already exists
    const existing = fs.readdirSync(photosDir).find((f) => f.startsWith(`${base}.`));
    if (existing && !force) {
      summary.skipped += 1;
      summary.items.push({
        handle: job.handle,
        nombre: job.nombre,
        estado: 'skipped',
        source_url: job.url,
        archivo_local: path.join(photosDir, existing),
        error: '',
      });
      logger?.info(`Omitida (ya existe): ${job.handle}`);
      return;
    }

    try {
      const response = await fetch(job.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; linkedin-contact-intelligence/1.0)',
          Accept: 'image/*,*/*',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`content-type no imagen: ${contentType}`);
      }
      const ext = extensionFromContentType(contentType, job.url);
      const filePath = path.join(photosDir, `${base}${ext}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 100) {
        throw new Error(`archivo demasiado pequeño (${buffer.length} bytes)`);
      }
      fs.writeFileSync(filePath, buffer);
      summary.downloaded += 1;
      summary.items.push({
        handle: job.handle,
        nombre: job.nombre,
        estado: 'downloaded',
        source_url: job.url,
        archivo_local: filePath,
        bytes: buffer.length,
        content_type: contentType,
        error: '',
      });
      logger?.info(`OK foto ${job.handle} (${buffer.length} bytes)`);
    } catch (error) {
      summary.failed += 1;
      summary.items.push({
        handle: job.handle,
        nombre: job.nombre,
        estado: 'failed',
        source_url: job.url,
        archivo_local: '',
        error: error.message || String(error),
      });
      logger?.error(`Fallo foto ${job.handle}: ${error.message || error}`);
    }
  });

  const report = {
    generated_at: new Date().toISOString(),
    photos_dir: photosDir,
    ...summary,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

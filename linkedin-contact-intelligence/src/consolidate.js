import fs from 'node:fs';
import path from 'node:path';
import { ACTORS } from './constants.js';
import { isValidRawJson } from './extract.js';
import { loadManifest } from './manifest.js';
import {
  ensureOutputDirs,
  getOutputPaths,
  postsRawPath,
  profileRawPath,
  sanitizeFilename,
} from './paths.js';

function readRaw(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function extractPostsFromItems(items) {
  const posts = [];
  for (const item of items || []) {
    const message = String(item?.message || item?.error || '');
    if (/no posts found/i.test(message)) continue;
    const nested = item?.data?.posts || item?.posts;
    if (Array.isArray(nested)) {
      for (const p of nested) posts.push(p);
    } else if (item && (item.full_urn || item.urn || item.url || item.text != null || item.posted_at)) {
      posts.push(item);
    }
  }
  return posts;
}

function activityUrnOf(post) {
  if (post?.activity_urn) return String(post.activity_urn);
  if (post?.urn && typeof post.urn === 'object') {
    return String(post.urn.activity_urn || post.urn.ugcPost_urn || post.urn.share_urn || '');
  }
  if (post?.urn != null && typeof post.urn !== 'object') return String(post.urn);
  return '';
}

function postDedupeKey(post, handle) {
  if (post?.full_urn) return `full_urn:${post.full_urn}`;
  const activity = activityUrnOf(post);
  if (activity) return `activity_urn:${activity}`;
  if (post?.url) return `url:${post.url}`;
  const date = post?.posted_at?.date || post?.postedAt || post?.date || '';
  const text = (post?.text || post?.commentary || '').slice(0, 200);
  return `fallback:${handle}|${date}|${text}`;
}

function flattenPost(post) {
  return {
    full_urn: post.full_urn || '',
    activity_urn: activityUrnOf(post),
    url: post.url || '',
    text: post.text || '',
    post_type: post.post_type || '',
    posted_at: post.posted_at?.date || '',
    posted_timestamp: post.posted_at?.timestamp || '',
    total_reactions: post.stats?.total_reactions ?? '',
    comments: post.stats?.comments ?? '',
    reposts: post.stats?.reposts ?? '',
  };
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function consolidateAll({ contacts, logger, projectRoot }) {
  const paths = getOutputPaths(projectRoot);
  ensureOutputDirs(paths);
  const manifestRows = loadManifest(paths.manifestCsv);

  const profiles = [];
  const posts = [];
  const seenPosts = new Set();
  const coverage = [];
  let postsRawCount = 0;
  let postsDedupedRemoved = 0;

  for (const contact of contacts.filter((c) => c.handle)) {
    const safe = sanitizeFilename(contact.handle);
    const profileFile = profileRawPath(paths, safe);
    const postsFile = postsRawPath(paths, safe);

    const profileOk = isValidRawJson(profileFile);
    const postsOk = isValidRawJson(postsFile);

    let profileMeta = null;
    let postsMeta = null;
    let postCount = 0;

    if (profileOk) {
      const raw = readRaw(profileFile);
      profileMeta = raw.meta || {};
      profiles.push({
        handle: contact.handle,
        url: contact.url,
        nombre: contact.nombre,
        institución_registrada: contact.institución,
        cargo_registrado: contact.cargo,
        prioridad: contact.prioridad,
        datos_apify: raw.items,
        actor_id: profileMeta.actor_id || ACTORS.profile.id,
        run_id: profileMeta.run_id || '',
        dataset_id: profileMeta.dataset_id || '',
        extracted_at: profileMeta.extracted_at || '',
        cost_usd: profileMeta.cost_usd ?? null,
        archivo_local: profileFile,
      });
    }

    if (postsOk) {
      const raw = readRaw(postsFile);
      postsMeta = raw.meta || {};
      const extracted = extractPostsFromItems(raw.items);
      postCount = extracted.length;
      postsRawCount += extracted.length;
      for (const post of extracted) {
        const key = postDedupeKey(post, contact.handle);
        if (seenPosts.has(key)) {
          postsDedupedRemoved += 1;
          continue;
        }
        seenPosts.add(key);
        posts.push({
          source_profile_handle: contact.handle,
          source_profile_url: contact.url,
          source_name: contact.nombre,
          source_institution: contact.institución,
          source_role: contact.cargo,
          source_priority: contact.prioridad,
          ...post,
          actor_id: postsMeta.actor_id || ACTORS.posts.id,
          run_id: postsMeta.run_id || '',
          dataset_id: postsMeta.dataset_id || '',
          extracted_at: postsMeta.extracted_at || '',
        });
      }
    }

    coverage.push({
      handle: contact.handle,
      nombre: contact.nombre,
      profile_extracted: profileOk,
      posts_extracted: postsOk,
      posts_count: postCount,
      zero_posts_ok: postsOk && postCount === 0,
      profile_run_id: profileMeta?.run_id || '',
      posts_run_id: postsMeta?.run_id || '',
    });
  }

  const intelligence = contacts
    .filter((c) => c.handle)
    .map((contact) => {
      const profile = profiles.find((p) => p.handle === contact.handle) || null;
      const contactPosts = posts.filter((p) => p.source_profile_handle === contact.handle);
      return {
        handle: contact.handle,
        url: contact.url,
        nombre: contact.nombre,
        institución: contact.institución,
        cargo: contact.cargo,
        prioridad: contact.prioridad,
        profile,
        posts: contactPosts,
        posts_count: contactPosts.length,
      };
    });

  fs.writeFileSync(paths.profilesConsolidated, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
  fs.writeFileSync(paths.postsConsolidated, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    paths.postsNdjson,
    `${posts.map((p) => JSON.stringify(p)).join('\n')}${posts.length ? '\n' : ''}`,
    'utf8',
  );

  const flatHeaders = [
    'source_profile_handle',
    'source_name',
    'source_institution',
    'source_role',
    'source_priority',
    'source_profile_url',
    'full_urn',
    'activity_urn',
    'url',
    'text',
    'post_type',
    'posted_at',
    'posted_timestamp',
    'total_reactions',
    'comments',
    'reposts',
    'actor_id',
    'run_id',
    'dataset_id',
    'extracted_at',
  ];
  const flatLines = [flatHeaders.join(',')];
  for (const post of posts) {
    const flat = flattenPost(post);
    const row = {
      source_profile_handle: post.source_profile_handle,
      source_name: post.source_name,
      source_institution: post.source_institution,
      source_role: post.source_role,
      source_priority: post.source_priority,
      source_profile_url: post.source_profile_url,
      ...flat,
      actor_id: post.actor_id,
      run_id: post.run_id,
      dataset_id: post.dataset_id,
      extracted_at: post.extracted_at,
    };
    flatLines.push(flatHeaders.map((h) => escapeCsv(row[h])).join(','));
  }
  fs.writeFileSync(paths.postsFlatCsv, `${flatLines.join('\n')}\n`, 'utf8');

  fs.writeFileSync(paths.contactIntelligence, `${JSON.stringify(intelligence, null, 2)}\n`, 'utf8');

  const summary = {
    generated_at: new Date().toISOString(),
    contacts_total: contacts.length,
    unique_handles: new Set(contacts.filter((c) => c.handle).map((c) => c.handle.toLocaleLowerCase('es'))).size,
    profiles_consolidated: profiles.length,
    posts_consolidated: posts.length,
    posts_raw_count: postsRawCount,
    posts_deduped_removed: postsDedupedRemoved,
    profiles_without_posts: coverage.filter((c) => c.posts_extracted && c.posts_count === 0).length,
    coverage,
    orphan_posts: posts.filter(
      (p) => !profiles.some((pr) => pr.handle === p.source_profile_handle),
    ).length,
    manifest_rows: manifestRows.length,
    outputs: {
      profiles: paths.profilesConsolidated,
      posts: paths.postsConsolidated,
      posts_ndjson: paths.postsNdjson,
      posts_csv: paths.postsFlatCsv,
      intelligence: paths.contactIntelligence,
    },
  };

  fs.writeFileSync(paths.coverageSummary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  logger?.info(
    `Consolidación: perfiles=${profiles.length} publicaciones=${posts.length} cobertura=${coverage.length}`,
  );

  return summary;
}

export function validateJsonTree(dir) {
  const problems = [];
  if (!fs.existsSync(dir)) return problems;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        try {
          JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (error) {
          problems.push({ file: full, error: error.message });
        }
      }
    }
  };
  walk(dir);
  return problems;
}

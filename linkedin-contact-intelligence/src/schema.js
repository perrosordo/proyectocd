/**
 * Structural guards based on confirmed pilot shapes.
 * Profile item: { basic_info, experience, education, ... }
 * Posts item: flat post with full_urn/posted_at/text/url (or nested data.posts)
 */

export function validateProfileItems(items) {
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'profile items no es un array' };
  }
  // Zero records is unusual for a public profile but not automatically fatal
  if (items.length === 0) {
    return { ok: true, warning: 'perfil sin registros' };
  }
  const sample = items[0];
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    return { ok: false, reason: 'item de perfil no es objeto' };
  }
  const hasBasic = sample.basic_info && typeof sample.basic_info === 'object';
  const hasExperience = Array.isArray(sample.experience);
  const hasEducation = Array.isArray(sample.education);
  if (!hasBasic && !hasExperience && !hasEducation) {
    return {
      ok: false,
      reason: 'estructura de perfil distinta al piloto (faltan basic_info/experience/education)',
    };
  }
  return { ok: true };
}

export function isEmptyPostsPayload(item) {
  if (!item || typeof item !== 'object') return false;
  const message = String(item.message || item.error || '').toLowerCase();
  if (/no posts found/i.test(message)) return true;
  if (Array.isArray(item?.data?.posts) && item.data.posts.length === 0) return true;
  if (Array.isArray(item?.posts) && item.posts.length === 0) return true;
  // Actor sometimes returns a status wrapper without post fields
  if (
    (item.profile_input || item.username || item.success === false || item.success === true)
    && !item.full_urn
    && !item.urn
    && !item.url
    && item.text == null
    && !item.posted_at
    && !Array.isArray(item?.data?.posts)
    && !Array.isArray(item?.posts)
  ) {
    return /no posts|not found|no results|empty/i.test(message) || message === '';
  }
  return false;
}

export function validatePostsItems(items) {
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'posts items no es un array' };
  }
  // Zero posts is acceptable
  if (items.length === 0) {
    return { ok: true };
  }

  const first = items[0];
  if (!first || typeof first !== 'object') {
    return { ok: false, reason: 'item de posts no es objeto' };
  }

  // Explicit empty-result wrappers from the actor
  if (items.every((it) => isEmptyPostsPayload(it))) {
    return { ok: true, empty: true };
  }

  const nested = first?.data?.posts || first?.posts;
  if (Array.isArray(nested)) {
    if (nested.length === 0) return { ok: true, empty: true };
    return validateFlatPost(nested[0]);
  }

  return validateFlatPost(first);
}

function validateFlatPost(post) {
  if (!post || typeof post !== 'object') {
    return { ok: false, reason: 'publicación no es objeto' };
  }
  const hasIdentity = Boolean(post.full_urn || post.urn || post.url);
  const hasContentSignal = Boolean(
    post.text != null
    || post.posted_at
    || post.post_type
    || post.stats
    || post.author,
  );
  if (!hasIdentity && !hasContentSignal) {
    return {
      ok: false,
      reason: 'estructura de publicación distinta al piloto (sin urn/url/texto/posted_at)',
    };
  }
  return { ok: true };
}

export function validateActorResultShape(tipo, items) {
  if (tipo === 'profile') return validateProfileItems(items);
  if (tipo === 'posts') return validatePostsItems(items);
  return { ok: false, reason: `tipo desconocido: ${tipo}` };
}

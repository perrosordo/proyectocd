/**
 * Normalize LinkedIn profile handle from URL or handle field.
 * Keeps Unicode; strips domain, /in/, trailing slashes, query and hash.
 */
export function normalizeHandle(urlOrHandle) {
  if (urlOrHandle == null) return null;
  let value = String(urlOrHandle).trim();
  if (!value) return null;

  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep original if malformed percent-encoding
  }

  value = value.replace(/\\/g, '/');

  // Strip protocol and any linkedin host variant (www., cl., pe., etc.)
  value = value.replace(/^https?:\/\//i, '');
  value = value.replace(/^(?:[a-z0-9-]+\.)*linkedin\.com\/?/i, '');
  value = value.replace(/^\/+/, '');

  // Prefer /in/ path segment
  const inMatch = value.match(/(?:^|\/)in\/([^/?#]+)/i);
  if (inMatch) {
    value = inMatch[1];
  } else {
    // Already a bare handle or leftover path
    value = value.split(/[/?#]/)[0];
    value = value.replace(/^in\//i, '');
  }

  value = value.replace(/\/+$/g, '').trim();
  if (!value) return null;

  try {
    value = decodeURIComponent(value);
  } catch {
    // ignore
  }

  return value;
}

export function buildCanonicalProfileUrl(handle) {
  if (!handle) return null;
  return `https://www.linkedin.com/in/${handle}`;
}

export function isLikelyLinkedInProfileUrl(url) {
  if (!url) return false;
  const s = String(url).trim();
  if (!s) return false;
  return /linkedin\.com\/in\//i.test(s) || Boolean(normalizeHandle(s));
}

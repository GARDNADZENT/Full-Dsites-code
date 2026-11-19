/**
 * Helpers for remembering where a signed-out visitor was trying to go.
 *
 * `ProtectedRoute` bounces signed-out visitors to `/auth`. Without remembering
 * the attempted destination, a deep link such as `/admin` silently lands the
 * user on the tenant dashboard after they sign in, which reads as "the admin
 * page doesn't open". We keep the destination in query state rather than a
 * cookie so the auth page can stay a plain, shareable URL.
 */

const SIGN_IN_PATH = '/auth';

/** Where to send someone who is already signed in and hits `/auth`. */
export const DEFAULT_SIGNED_IN_DESTINATION = '/';

/**
 * Turn the current full path (pathname + search + hash) into the value we hand
 * to `/auth` as `?next=`. Returns null when the destination is the sign-in page
 * itself, so we never build a redirect loop.
 */
export function buildNextParam(fullPath: string): string | null {
  if (!fullPath || !fullPath.startsWith('/')) return null;
  if (fullPath === SIGN_IN_PATH || fullPath.startsWith(`${SIGN_IN_PATH}?`) || fullPath.startsWith(`${SIGN_IN_PATH}/`)) {
    return null;
  }
  return fullPath;
}

/** Build the sign-in URL for a destination, falling back to a bare `/auth`. */
export function buildSignInUrl(fullPath: string): string {
  const next = buildNextParam(fullPath);
  return next ? `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}` : SIGN_IN_PATH;
}

/**
 * Read and validate the `next` query parameter. Only same-origin, absolute
 * application paths are accepted so the parameter can never be used as an open
 * redirect.
 */
export function readNextParam(search: string, fallback = DEFAULT_SIGNED_IN_DESTINATION): string {
  const raw = new URLSearchParams(search).get('next');
  if (!raw) return fallback;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (!decoded.startsWith('/')) return fallback;
  // Reject protocol-relative and backslash tricks (`//evil.com`, `/\evil.com`).
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return fallback;
  if (buildNextParam(decoded) === null) return fallback;
  return decoded;
}

/**
 * True when the destination is the platform admin area, so the sign-in page can
 * label itself as the admin sign-in instead of the tenant one.
 */
export function isAdminDestination(fullPath: string): boolean {
  return fullPath === '/admin' || fullPath.startsWith('/admin/') || fullPath.startsWith('/admin?');
}

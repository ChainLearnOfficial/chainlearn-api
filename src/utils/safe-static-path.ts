import path from "node:path";

/**
 * Resolve a user-supplied filename against a static-file directory, safely
 * (#486). Used for GET /uploads/avatars/:filename, where `filename` is a raw
 * route parameter and therefore untrusted.
 *
 * Two independent layers, so a bypass of one alone isn't enough:
 * 1. `path.basename()` strips any directory components — a `../` sequence
 *    (plain, URL-encoded, or double-encoded and decoded upstream by Fastify)
 *    can't survive into the joined path, because everything before the last
 *    separator is discarded outright.
 * 2. The resolved path is still verified to fall inside `uploadDir` before
 *    being returned, so this only requires trusting the intersection of
 *    both checks, not either one in isolation.
 *
 * Returns null when either the name fails `allowedPattern` or the resolved
 * path would fall outside `uploadDir` — both are "reject", not "sanitize
 * and continue", so a caller can 404 uniformly without telling an attacker
 * which check tripped.
 */
export function resolveSafeStaticPath(
  filename: string,
  uploadDir: string,
  allowedPattern: RegExp,
): string | null {
  const safeName = path.basename(filename);
  if (!allowedPattern.test(safeName)) {
    return null;
  }

  const resolvedUploadDir = path.resolve(uploadDir);
  const resolvedPath = path.resolve(resolvedUploadDir, safeName);

  if (!resolvedPath.startsWith(resolvedUploadDir + path.sep)) {
    return null;
  }

  return resolvedPath;
}

/**
 * Read the HTTP status off a thrown error.
 *
 * The SDK attaches `statusCode`; a raw fetch-style rejection carries `status`.
 * Several call sites branch on the status to decide whether a failure is
 * permanent (403 on an admin-only delete, 412 on a stale precondition) or worth
 * retrying, so the two shapes must be read the same way everywhere — a site
 * that checked only one of them would silently treat a real 403 as unknown and
 * retry it forever.
 */
export function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { statusCode?: unknown }).statusCode ?? (err as { status?: unknown }).status;
  return typeof code === 'number' ? code : undefined;
}

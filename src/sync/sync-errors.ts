/**
 * A sync path failed containment: traversal, absolute path, symlink, reserved marker,
 * or an untrusted sync root.
 *
 * This is a distinct class so callers that isolate per-document failures (the remote
 * poller batches many documents and must not let one bad document wedge the rest) can
 * still let a containment failure abort the whole operation. Swallowing one of these
 * as "just another failed document" would turn a rejected path traversal into a
 * silently skipped entry.
 *
 * It lives in its own module rather than in safe-path.ts because root-marker.ts also
 * throws it, and safe-path.ts imports the marker constant from root-marker.ts — a
 * direct import between the two would form a cycle.
 */
export class SyncPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncPathError';
  }
}

import { getClientAsync } from '../client.js';

// Deliberate duplicate of packages/api/src/utils/uuid.ts UUID_RE, and resolveVaultId
// below is the CLI twin of vault.service.ts getByIdOrSlug — the same "a UUID means an
// id, anything else is a slug" decision.
//
// It stays duplicated on purpose. The CLI is published standalone to npm and cannot
// import from packages/api, nor from @lifestreamdynamics/vault-shared, which is
// unpublished — depending on it breaks `npm install` for CLI users with an E404.
// Resolving this properly is a packaging decision (publishing a primitives package),
// not a code cleanup, so it is tracked in FINDINGS_OUTSIDE_SCOPE.md. If you change
// this pattern, change it in both places.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts either a vault UUID or a vault slug. If a UUID is given it is
 * returned unchanged. If a slug is given, the vault list is fetched and the
 * matching vault's ID is returned.
 *
 * @throws {Error} If the slug does not match any vault.
 */
export async function resolveVaultId(idOrSlug: string): Promise<string> {
  if (UUID_RE.test(idOrSlug)) return idOrSlug;
  const client = await getClientAsync();
  const vaults = await client.vaults.list({ includeArchived: true });
  const match = vaults.find(v => v.slug === idOrSlug);
  if (!match) throw new Error(`Vault not found: "${idOrSlug}"`);
  return match.id;
}

import { getClientAsync } from '../client.js';

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
  const vaults = await client.vaults.list();
  const match = vaults.find(v => v.slug === idOrSlug);
  if (!match) throw new Error(`Vault not found: "${idOrSlug}"`);
  return match.id;
}

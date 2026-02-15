# Lifestream Vault CLI

Command-line interface for [Lifestream Vault](https://lifestreamdynamics.com) - a multi-user Markdown document storage service with WebDAV sync.

## Installation

```bash
npm install -g @lifestream-vault/cli
```

## Quick Start

```bash
# Login to your Lifestream Vault instance
lsvault login https://your-instance.com

# List your vaults
lsvault vaults list

# Clone a vault to your local machine
lsvault clone <vault-id> ./my-vault

# Watch for changes and sync automatically
lsvault sync ./my-vault --watch

# Push local changes to the server
lsvault push ./my-vault

# Pull remote changes from the server
lsvault pull ./my-vault

# Search across documents
lsvault search <vault-id> "query"
```

## Features

- **Authentication**: Secure login with API keys or email/password
- **Vault Management**: Create, list, and manage vaults
- **Bidirectional Sync**: Keep local files in sync with remote vault
- **Watch Mode**: Automatically sync changes as you edit
- **Search**: Full-text search across all documents
- **Offline Support**: Work offline and sync when reconnected

## Commands

### Authentication

```bash
lsvault login <api-url>         # Login to a Lifestream Vault instance
lsvault logout                  # Logout from current session
lsvault whoami                  # Show current user info
```

### Vaults

```bash
lsvault vaults list             # List all vaults
lsvault vaults create <name>    # Create a new vault
lsvault vaults info <vault-id>  # Show vault details
```

### Sync Operations

```bash
lsvault clone <vault-id> <dir>       # Clone vault to local directory
lsvault sync <dir> [--watch]         # Sync vault (with optional watch mode)
lsvault push <dir>                   # Push local changes to server
lsvault pull <dir>                   # Pull remote changes from server
```

### Documents

```bash
lsvault docs list <vault-id>         # List documents in vault
lsvault docs get <vault-id> <path>   # Get document content
lsvault docs create <vault-id> <path> --content "..." # Create document
lsvault docs delete <vault-id> <path> # Delete document
```

### Search

```bash
lsvault search <vault-id> <query>    # Search documents
lsvault search <vault-id> <query> --semantic  # Semantic search (AI)
```

## Configuration

The CLI stores credentials in your system keychain (via `keytar`) or falls back to `~/.lifestream-vault/config.json` if keychain is unavailable.

```json
{
  "apiUrl": "https://your-instance.com/api/v1",
  "apiKey": "lsv_k_your_api_key"
}
```

## Watch Mode

Use `--watch` to automatically sync changes:

```bash
lsvault sync ./my-vault --watch
```

This monitors your local directory for changes and syncs them in real-time.

## Environment Variables

- `LIFESTREAM_VAULT_API_URL` - Override default API URL
- `LIFESTREAM_VAULT_API_KEY` - Override default API key

## Documentation

For full documentation, visit [https://docs.lifestreamdynamics.com](https://docs.lifestreamdynamics.com)

## Related Packages

- [@lifestream-vault/sdk](https://www.npmjs.com/package/@lifestream-vault/sdk) - TypeScript SDK

## License

MIT

## Support

- **Issues**: [GitHub Issues](https://github.com/lifestreamdynamics/lifestream-vault-cli/issues)
- **Email**: eric@lifestreamdynamics.com

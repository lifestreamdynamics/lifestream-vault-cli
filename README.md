# Lifestream Vault CLI

A powerful command-line interface for Lifestream Vault - the multi-user Markdown document storage service with WebDAV sync, search, and collaboration features.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@lifestreamdynamics/vault-cli.svg)](https://www.npmjs.com/package/@lifestreamdynamics/vault-cli)

## 📖 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Authentication](#-authentication)
- [Commands Reference](#-commands-reference)
  - [Authentication Commands](#authentication-commands)
  - [Vault Commands](#vault-commands)
  - [Document Commands](#document-commands)
  - [Sync Commands](#sync-commands)
  - [Search Commands](#search-commands)
  - [Team Commands](#team-commands)
  - [Sharing & Publishing](#sharing--publishing)
  - [Hooks & Webhooks](#hooks--webhooks)
  - [Admin Commands](#admin-commands)
- [Sync & Watch Mode](#-sync--watch-mode)
- [Configuration](#️-configuration)
- [Environment Variables](#-environment-variables)
- [Credential Storage](#-credential-storage)
- [Examples](#-examples)
- [Troubleshooting](#-troubleshooting)
- [Related Packages](#-related-packages)
- [Documentation](#-documentation)
- [Support](#-support)
- [License](#-license)

## ✨ Features

- **🔐 Secure Authentication** - API key or email/password login with secure credential storage (system keychain with encrypted fallback)
- **📁 Vault Management** - Create, list, update, and delete vaults with full CRUD operations
- **📄 Document Operations** - Read, write, update, and delete Markdown documents with metadata support
- **🔄 Bidirectional Sync** - Clone vaults locally and sync changes in both directions (pull, push, or bidirectional)
- **👁️ Watch Mode** - Real-time file watching with automatic sync on local changes
- **🔍 Full-Text Search** - Search across all documents with advanced filtering and semantic search
- **👥 Team Collaboration** - Manage teams, invitations, and shared vaults
- **🔗 Sharing & Publishing** - Create share links and publish documents publicly
- **🪝 Hooks & Webhooks** - Configure event hooks and webhook integrations
- **🔌 Connector Management** - Integrate with external services (Google Drive, etc.)
- **🎯 Conflict Resolution** - Smart conflict detection with configurable resolution strategies
- **📊 Subscription Management** - View and manage subscription tiers and usage
- **🛡️ Admin Tools** - User management, system stats, and audit logs (admin only)
- **⚙️ Flexible Configuration** - Multiple profiles, environment variable support, and configurable sync behavior
- **🌐 Offline Support** - Work offline and sync when reconnected
- **📦 TypeScript SDK** - Built on `@lifestreamdynamics/vault-sdk` with full type safety

## 📦 Installation

### Global Installation (Recommended)

```bash
npm install -g @lifestreamdynamics/vault-cli
```

After installation, the `lsvault` command will be available globally:

```bash
lsvault --help
```

### Local Installation (Project-Specific)

```bash
npm install @lifestreamdynamics/vault-cli

# Run with npx
npx lsvault --help
```

### Build from Source

```bash
git clone https://github.com/lifestreamdynamics/lifestream-vault-cli.git
cd lifestream-vault-cli
npm install
npm run build

# Link globally
npm link
```

## 🚀 Quick Start

### 1. Authenticate

```bash
# Login with API key
lsvault auth login --api-key lsv_k_your_api_key_here

# Or login with email/password
lsvault auth login --email user@example.com

# Set a custom API URL (optional)
lsvault auth login --api-key lsv_k_your_key --api-url https://vault.lifestreamdynamics.com
```

### 2. List Your Vaults

```bash
lsvault vaults list
```

### 3. Clone a Vault Locally

```bash
# Initialize sync for a vault
lsvault sync init <vaultId> ~/Documents/my-vault

# Perform initial pull
lsvault sync pull <syncId>
```

### 4. Enable Watch Mode

```bash
# Start daemon for automatic sync
lsvault sync daemon start

# Or watch manually with auto-sync enabled
lsvault sync watch <syncId>
```

### 5. Search Documents

```bash
# Full-text search
lsvault search "project notes"

# Semantic search (AI-powered)
lsvault search semantic "how to deploy the app"
```

## 🔐 Authentication

The CLI supports two authentication methods:

### API Key Authentication

API keys are ideal for automation, scripts, and CI/CD pipelines:

```bash
lsvault auth login --api-key lsv_k_your_api_key_here
```

**Create an API Key:**
```bash
lsvault keys create --name "CI/CD Pipeline" --scopes vaults:read,documents:read
```

### Email/Password Authentication

Email/password login provides access to all features and automatically manages JWT tokens:

```bash
lsvault auth login --email user@example.com
# (prompts for password interactively)

# Or provide password inline (less secure)
lsvault auth login --email user@example.com --password your_password
```

**Token Refresh:**
```bash
lsvault auth refresh
```

### Check Authentication Status

```bash
lsvault auth status
```

### Logout

```bash
lsvault auth logout
```

## 📚 Commands Reference

### Authentication Commands

| Command | Description |
|---------|-------------|
| `lsvault auth login` | Authenticate with API key or email/password |
| `lsvault auth logout` | Clear all stored credentials |
| `lsvault auth refresh` | Refresh JWT access token |
| `lsvault auth status` | Show current authentication status |
| `lsvault auth whoami` | Display current user information |
| `lsvault auth migrate` | Migrate plaintext credentials to secure storage |

### Vault Commands

| Command | Description |
|---------|-------------|
| `lsvault vaults list` | List all accessible vaults |
| `lsvault vaults create` | Create a new vault |
| `lsvault vaults get <vaultId>` | Get vault details |
| `lsvault vaults update <vaultId>` | Update vault settings |
| `lsvault vaults delete <vaultId>` | Delete a vault |
| `lsvault vaults tree <vaultId>` | Display vault directory tree |

**Example:**
```bash
# Create a vault
lsvault vaults create --name "Work Notes" --description "Professional documentation"

# Get vault details
lsvault vaults get vault_abc123
```

### Document Commands

| Command | Description |
|---------|-------------|
| `lsvault docs list <vaultId>` | List all documents in a vault |
| `lsvault docs get <vaultId> <path>` | Get document content |
| `lsvault docs create <vaultId> <path>` | Create a new document |
| `lsvault docs update <vaultId> <path>` | Update a document |
| `lsvault docs delete <vaultId> <path>` | Delete a document |

**Example:**
```bash
# List documents
lsvault docs list vault_abc123

# Read a document (outputs to stdout)
lsvault docs get vault_abc123 /notes/meeting.md

# Create a document from file
lsvault docs create vault_abc123 /notes/new.md --file ~/draft.md

# Create with inline content
lsvault docs create vault_abc123 /notes/quick.md --content "# Quick Note\n\nThis is a test."

# Update a document
lsvault docs update vault_abc123 /notes/meeting.md --file ~/updated.md
```

### Sync Commands

| Command | Description |
|---------|-------------|
| `lsvault sync init <vaultId> <localPath>` | Initialize sync configuration |
| `lsvault sync list` | List all sync configurations |
| `lsvault sync status <syncId>` | Show sync status and statistics |
| `lsvault sync pull <syncId>` | Pull remote changes to local |
| `lsvault sync push <syncId>` | Push local changes to remote |
| `lsvault sync watch <syncId>` | Watch for changes and auto-sync |
| `lsvault sync daemon start` | Start background sync daemon |
| `lsvault sync daemon stop` | Stop background sync daemon |
| `lsvault sync daemon status` | Check daemon status |
| `lsvault sync delete <syncId>` | Remove sync configuration |

**Example:**
```bash
# Initialize sync with custom options
lsvault sync init vault_abc123 ~/my-vault \
  --mode sync \
  --on-conflict newer \
  --ignore ".git/**" "*.tmp" \
  --auto-sync \
  --interval 5m

# Perform one-time pull
lsvault sync pull sync_xyz789

# Watch and sync automatically
lsvault sync watch sync_xyz789

# Start daemon for all syncs
lsvault sync daemon start
```

### Search Commands

| Command | Description |
|---------|-------------|
| `lsvault search <query>` | Full-text search across all documents |
| `lsvault search semantic <query>` | Semantic search using AI embeddings |

**Example:**
```bash
# Full-text search
lsvault search "project timeline" --vault vault_abc123

# Semantic search
lsvault search semantic "explain the deployment process"

# Search with filters
lsvault search "meeting" --tags work,urgent --limit 10
```

### Team Commands

| Command | Description |
|---------|-------------|
| `lsvault teams list` | List all teams |
| `lsvault teams create` | Create a new team |
| `lsvault teams get <teamId>` | Get team details |
| `lsvault teams update <teamId>` | Update team settings |
| `lsvault teams delete <teamId>` | Delete a team |
| `lsvault teams members <teamId>` | List team members |
| `lsvault teams invite <teamId>` | Invite user to team |
| `lsvault teams remove <teamId> <userId>` | Remove member from team |

**Example:**
```bash
# Create a team
lsvault teams create --name "Engineering" --description "Dev team workspace"

# Invite a member
lsvault teams invite team_abc123 --email engineer@example.com --role member

# List members
lsvault teams members team_abc123
```

### Sharing & Publishing

| Command | Description |
|---------|-------------|
| `lsvault shares list` | List all share links |
| `lsvault shares create <vaultId> <path>` | Create a share link for a document |
| `lsvault shares revoke <shareId>` | Revoke a share link |
| `lsvault publish list` | List published documents |
| `lsvault publish create <vaultId> <path>` | Publish a document publicly |
| `lsvault publish unpublish <publishId>` | Unpublish a document |

**Example:**
```bash
# Create a password-protected share link
lsvault shares create vault_abc123 /reports/Q1.md \
  --password secret123 \
  --expires-in 7d

# Publish a document
lsvault publish create vault_abc123 /blog/post.md --slug my-first-post
```

### Hooks & Webhooks

| Command | Description |
|---------|-------------|
| `lsvault hooks list <vaultId>` | List vault hooks |
| `lsvault hooks create <vaultId>` | Create a new hook |
| `lsvault hooks update <hookId>` | Update hook configuration |
| `lsvault hooks delete <hookId>` | Delete a hook |
| `lsvault webhooks list` | List all webhooks |
| `lsvault webhooks create` | Create a new webhook |
| `lsvault webhooks update <webhookId>` | Update webhook configuration |
| `lsvault webhooks delete <webhookId>` | Delete a webhook |

**Example:**
```bash
# Create an auto-tag hook
lsvault hooks create vault_abc123 \
  --type auto-tag \
  --config '{"patterns":{"meeting":"#meeting"}}'

# Create a webhook for document updates
lsvault webhooks create \
  --url https://api.example.com/webhook \
  --events document.created,document.updated \
  --secret webhook_secret_key
```

### Admin Commands

**Note:** Admin commands require admin role.

| Command | Description |
|---------|-------------|
| `lsvault admin users list` | List all users |
| `lsvault admin users get <userId>` | Get user details |
| `lsvault admin users update <userId>` | Update user settings |
| `lsvault admin users delete <userId>` | Delete a user |
| `lsvault admin stats` | View system statistics |
| `lsvault audit logs` | View audit logs |

**Example:**
```bash
# List all users (admin only)
lsvault admin users list

# View system stats
lsvault admin stats

# View audit logs
lsvault audit logs --limit 100 --filter-action document.created
```

## 🔄 Sync & Watch Mode

The CLI provides powerful sync capabilities with real-time file watching.

### Sync Modes

- **`pull`** - Only download remote changes (one-way from server)
- **`push`** - Only upload local changes (one-way to server)
- **`sync`** - Bidirectional sync (default)

### Conflict Resolution Strategies

When the same file is modified both locally and remotely, the CLI uses a conflict resolution strategy:

- **`newer`** - Keep the newer version (based on modification time) - **default**
- **`local`** - Always prefer local version
- **`remote`** - Always prefer remote version
- **`ask`** - Prompt the user to choose (interactive mode)

### Watch Mode

Watch mode continuously monitors the local directory for changes and automatically syncs:

```bash
# Watch with default settings
lsvault sync watch sync_xyz789

# Watch with custom interval
lsvault sync init vault_abc123 ~/my-vault \
  --auto-sync \
  --interval 2m
lsvault sync watch sync_xyz789
```

**How it works:**
1. Monitors local file changes using `chokidar`
2. Debounces changes (500ms) to avoid excessive syncs
3. Automatically syncs when changes are detected
4. Polls remote for changes at configurable intervals
5. Handles conflicts using the configured strategy

### Background Daemon

Run sync in the background across all configured vaults:

```bash
# Start daemon
lsvault sync daemon start

# Check daemon status
lsvault sync daemon status

# Stop daemon
lsvault sync daemon stop
```

The daemon runs as a background process and syncs all configured vaults with `autoSync` enabled.

### Ignore Patterns

Exclude files from sync using glob patterns:

```bash
lsvault sync init vault_abc123 ~/my-vault \
  --ignore ".git/**" "*.tmp" "node_modules/**" ".DS_Store"
```

Patterns use [minimatch](https://github.com/isaacs/minimatch) syntax.

## ⚙️ Configuration

### Configuration File

The CLI stores configuration in `~/.lsvault/config.json`:

```json
{
  "apiUrl": "https://vault.lifestreamdynamics.com"
}
```

**Note:** Credentials are stored securely in the system keychain (or encrypted file fallback), not in the plaintext config file.

> **Self-hosting?** Replace `https://vault.lifestreamdynamics.com` with your server's URL, or set the `LSVAULT_API_URL` environment variable.

### Configuration Profiles

Manage multiple configurations with profiles:

```bash
# List profiles
lsvault config profiles

# Create a profile
lsvault config create-profile production --api-url https://vault.lifestreamdynamics.com

# Switch profiles
lsvault config use production

# Set config values
lsvault config set apiUrl https://vault.lifestreamdynamics.com

# Get config values
lsvault config get apiUrl
```

### Sync Configuration

Sync configurations are stored per vault in `~/.lsvault/sync/`:

```json
{
  "id": "sync_abc123",
  "vaultId": "vault_xyz789",
  "localPath": "/home/user/my-vault",
  "mode": "sync",
  "onConflict": "newer",
  "ignore": [".git/**", "*.tmp"],
  "autoSync": true,
  "syncInterval": "5m"
}
```

## 🌍 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LSVAULT_API_URL` | API server base URL | `https://vault.lifestreamdynamics.com` |
| `LSVAULT_API_KEY` | API key for authentication | - |
| `LSVAULT_CONFIG_DIR` | Configuration directory | `~/.lsvault` |
| `LSVAULT_PROFILE` | Active configuration profile | `default` |

**Example:**
```bash
export LSVAULT_API_URL=https://vault.lifestreamdynamics.com
export LSVAULT_API_KEY=lsv_k_your_key_here
lsvault vaults list
```

## 🔒 Credential Storage

The CLI uses secure credential storage with automatic fallback:

### Storage Methods (Priority Order)

1. **System Keychain** (macOS Keychain, Windows Credential Manager, Linux Secret Service)
   - Most secure option
   - Requires optional `keytar` dependency
   - Used automatically if available

2. **Encrypted Config File** (`~/.lsvault/encrypted-config.json`)
   - AES-256-GCM encryption
   - Password-protected
   - Fallback when keychain unavailable

3. **Plaintext Config** (`~/.lsvault/config.json`) - **Deprecated**
   - Legacy storage method
   - Automatically migrated to secure storage
   - Not recommended for production use

### Migration

Migrate existing plaintext credentials to secure storage:

```bash
lsvault auth migrate
```

The CLI will automatically prompt for migration when plaintext credentials are detected.

### Check Storage Method

```bash
lsvault auth status
```

Output includes current storage method:
```
Storage Method: keychain (macOS Keychain)
Auth Type: JWT Token
Status: ✓ Authenticated
User: user@example.com
```

## 📖 Examples

### Complete Workflow: Clone and Sync a Vault

```bash
# 1. Login
lsvault auth login --email user@example.com

# 2. List available vaults
lsvault vaults list

# 3. Initialize sync
lsvault sync init vault_abc123 ~/Documents/work-notes \
  --mode sync \
  --on-conflict newer \
  --auto-sync \
  --interval 5m

# 4. Perform initial sync
lsvault sync pull sync_xyz789

# 5. Start watching for changes
lsvault sync watch sync_xyz789
```

### Search and Share Workflow

```bash
# Search for documents
lsvault search "quarterly report" --vault vault_abc123 --json

# Create a share link for the found document
lsvault shares create vault_abc123 /reports/Q4-2025.md \
  --password secure123 \
  --expires-in 30d

# Publish a document publicly
lsvault publish create vault_abc123 /blog/announcement.md \
  --slug new-features-2026
```

### Team Collaboration Workflow

```bash
# Create a team
lsvault teams create --name "Product Team" --description "Product docs"

# Create a shared vault
lsvault vaults create --name "Product Docs" --team team_abc123

# Invite team members
lsvault teams invite team_abc123 --email pm@example.com --role admin
lsvault teams invite team_abc123 --email dev@example.com --role member

# Configure webhook for team updates
lsvault webhooks create \
  --url https://slack.example.com/webhook \
  --events document.created,document.updated \
  --filter '{"vaultId":"vault_xyz789"}'
```

### Automation with API Keys

```bash
# Create a read-only API key for monitoring
lsvault keys create \
  --name "Monitoring Script" \
  --scopes vaults:read,documents:read \
  --expires-in 90d

# Use API key in scripts
export LSVAULT_API_KEY=lsv_k_generated_key
lsvault vaults list --json | jq '.[] | .name'
```

## 🐛 Troubleshooting

### Authentication Issues

**Problem:** `Authentication failed` error

**Solutions:**
1. Verify credentials are correct
2. Check API URL is accessible: `curl <API_URL>/api/v1/health`
3. Refresh JWT token: `lsvault auth refresh`
4. Re-login: `lsvault auth logout && lsvault auth login --email user@example.com`

### Sync Issues

**Problem:** Sync not detecting changes

**Solutions:**
1. Check sync status: `lsvault sync status <syncId>`
2. Verify file paths are correct
3. Check ignore patterns aren't excluding files
4. Manually trigger sync: `lsvault sync pull <syncId>`
5. Restart watch mode

**Problem:** Sync conflicts

**Solutions:**
1. Review conflict strategy: `lsvault sync status <syncId>`
2. Change conflict resolution: `lsvault sync init <vaultId> <path> --on-conflict ask`
3. Manually resolve conflicts and re-sync

### Credential Storage Issues

**Problem:** `keytar` not available

**Solution:** The CLI automatically falls back to encrypted config. Install optional dependency for keychain support:
```bash
npm install -g keytar
```

**Problem:** Need to migrate plaintext credentials

**Solution:**
```bash
lsvault auth migrate
```

### Daemon Issues

**Problem:** Daemon won't start

**Solutions:**
1. Check if daemon is already running: `lsvault sync daemon status`
2. Stop existing daemon: `lsvault sync daemon stop`
3. Check logs: `cat ~/.lsvault/daemon/daemon.log`
4. Verify sync configs have `autoSync: true`

### Network Issues

**Problem:** Connection timeouts

**Solutions:**
1. Verify API URL is correct: `lsvault config get apiUrl`
2. Test connectivity: `curl <API_URL>/api/v1/health`
3. Check firewall/proxy settings
4. Use custom API URL: `lsvault auth login --api-url https://vault.lifestreamdynamics.com`

### Output Format Issues

**Problem:** Need machine-readable output

**Solution:** Use `--json` or `--quiet` flags:
```bash
lsvault vaults list --json
lsvault search "query" --json | jq '.[] | .path'
lsvault docs get vault_abc123 /path.md --quiet > output.md
```

## 🔗 Related Packages

- **[@lifestreamdynamics/vault-sdk](https://npmjs.com/package/@lifestreamdynamics/vault-sdk)** - TypeScript SDK for Lifestream Vault API
- **[@lifestreamdynamics/vault-api](https://github.com/lifestreamdynamics/lifestream-vault)** - Backend API server
- **[@lifestreamdynamics/vault-web](https://github.com/lifestreamdynamics/lifestream-vault)** - Web frontend

## 📄 Documentation

- **Full Documentation**: [vault.lifestreamdynamics.com/docs](https://vault.lifestreamdynamics.com/docs)
- **API Reference**: [vault.lifestreamdynamics.com/docs/api](https://vault.lifestreamdynamics.com/docs/api)
- **SDK Documentation**: [vault.lifestreamdynamics.com/docs/sdk](https://vault.lifestreamdynamics.com/docs/sdk)
- **WebDAV Setup**: [vault.lifestreamdynamics.com/docs/webdav](https://vault.lifestreamdynamics.com/docs/webdav)

## 💬 Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/lifestreamdynamics/lifestream-vault-cli/issues)
- **Documentation**: [vault.lifestreamdynamics.com/docs](https://vault.lifestreamdynamics.com/docs)
- **Email**: eric@lifestreamdynamics.com

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

---

**Built with ❤️ by [Lifestream Dynamics](https://lifestreamdynamics.com)**

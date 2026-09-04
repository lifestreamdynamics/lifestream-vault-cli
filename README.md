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
  - [Publish Vault Commands](#publish-vault-commands)
  - [Hooks & Webhooks](#hooks--webhooks)
  - [Links & Backlinks](#links--backlinks)
  - [Calendar Commands](#calendar)
  - [Booking Commands](#booking-commands)
  - [AI Commands](#ai-commands)
  - [Analytics Commands](#analytics-commands)
  - [Custom Domain Commands](#custom-domain-commands)
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
lsvault search "how to deploy the app" --mode semantic
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
lsvault keys create "CI/CD Pipeline" --scopes read,write
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
| `lsvault vaults create <name>` | Create a new vault |
| `lsvault vaults get <vaultId>` | Get vault details |
| `lsvault vaults tree <vaultId>` | Display vault directory tree |
| `lsvault vaults archive <vaultId>` | Archive a vault |
| `lsvault vaults unarchive <vaultId>` | Unarchive a vault |
| `lsvault vaults transfer <vaultId> <targetEmail>` | Transfer vault ownership |

**Example:**
```bash
# Create a vault
lsvault vaults create "Work Notes" --description "Professional documentation"

# Get vault details
lsvault vaults get vault_abc123
```

### Document Commands

| Command | Description |
|---------|-------------|
| `lsvault docs list <vaultId>` | List all documents in a vault |
| `lsvault docs get <vaultId> <path>` | Get document content |
| `lsvault docs put <vaultId> <path>` | Create or update a document (reads from stdin) |
| `lsvault docs delete <vaultId> <path>` | Delete a document |
| `lsvault docs move <vaultId> <source> <dest>` | Move or rename a document |
| `lsvault docs mkdir <vaultId> <path>` | Create a directory |
| `lsvault docs bulk-move <vaultId> --paths <csv> --target <dir>` | Move multiple documents to a target directory |
| `lsvault docs bulk-copy <vaultId> --paths <csv> --target <dir>` | Copy multiple documents to a target directory |
| `lsvault docs bulk-delete <vaultId> --paths <csv>` | Delete multiple documents |
| `lsvault docs bulk-tag <vaultId> --paths <csv> [--add <csv>] [--remove <csv>]` | Add or remove tags on multiple documents |

**Example:**
```bash
# List documents
lsvault docs list vault_abc123

# Read a document (outputs to stdout)
lsvault docs get vault_abc123 notes/meeting.md

# Create or update a document from a local file (via stdin)
cat ~/draft.md | lsvault docs put vault_abc123 notes/new.md

# Create with inline content
echo "# Quick Note\n\nThis is a test." | lsvault docs put vault_abc123 notes/quick.md

# Show document metadata
lsvault docs get vault_abc123 notes/meeting.md --meta
```

### Sync Commands

| Command | Description |
|---------|-------------|
| `lsvault sync init <vaultId> <localPath> [--create-dir]` | Initialize sync; optionally create a missing local directory |
| `lsvault sync trust-root <syncId>` | Verify and mark a legacy sync root before first use |
| `lsvault sync list` | List all sync configurations |
| `lsvault sync status <syncId>` | Show sync status and statistics |
| `lsvault sync pull <syncId>` | Pull remote changes to local |
| `lsvault sync push <syncId>` | Push local changes to remote |
| `lsvault sync watch <syncId>` | Watch for changes and auto-sync |
| `lsvault sync daemon start` | Start background sync daemon |
| `lsvault sync daemon run` | Run daemon in the foreground for a service supervisor |
| `lsvault sync daemon stop` | Stop background sync daemon |
| `lsvault sync daemon status` | Check daemon status |
| `lsvault sync resolve <syncId> <docPath> --use <local\|remote>` | Manually resolve a sync conflict |
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

# A missing directory is rejected unless creation is explicit
lsvault sync init vault_abc123 ~/new-vault --create-dir

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
| `lsvault search <query> --mode semantic` | Semantic search using AI embeddings |
| `lsvault search <query> --mode hybrid` | Hybrid text + semantic search |

**Example:**
```bash
# Full-text search
lsvault search "project timeline" --vault vault_abc123

# Semantic search
lsvault search "explain the deployment process" --mode semantic

# Search with filters
lsvault search "meeting" --tags work,urgent --limit 10
```

### Team Commands

| Command | Description |
|---------|-------------|
| `lsvault teams list` | List all teams |
| `lsvault teams create <name>` | Create a new team |
| `lsvault teams get <teamId>` | Get team details |
| `lsvault teams update <teamId>` | Update team settings |
| `lsvault teams delete <teamId>` | Delete a team |
| `lsvault teams members list <teamId>` | List team members |
| `lsvault teams members update <teamId> <userId> --role <role>` | Update a member's role (admin/editor/viewer) |
| `lsvault teams members remove <teamId> <userId>` | Remove member from team |
| `lsvault teams invitations create <teamId> <email> --role <role>` | Invite a user to the team |
| `lsvault teams invitations list <teamId>` | List pending invitations |
| `lsvault teams invitations revoke <teamId> <invitationId>` | Revoke an invitation |
| `lsvault teams vaults list <teamId>` | List shared team vaults |
| `lsvault teams vaults create <teamId> <name>` | Create a shared team vault |

**Example:**
```bash
# Create a team
lsvault teams create "Engineering" --description "Dev team workspace"

# Invite a member
lsvault teams invitations create team_abc123 engineer@example.com --role editor

# List members
lsvault teams members list team_abc123
```

### Sharing & Publishing

| Command | Description |
|---------|-------------|
| `lsvault shares list <vaultId> <path>` | List share links for a document |
| `lsvault shares create <vaultId> <path>` | Create a share link for a document |
| `lsvault shares revoke <vaultId> <shareId>` | Revoke a share link |
| `lsvault publish list <vaultId>` | List published documents in a vault |
| `lsvault publish create <vaultId> <path> --slug <slug>` | Publish a document publicly |
| `lsvault publish delete <vaultId> <path>` | Unpublish a document |

**Example:**
```bash
# Create a password-protected share link (prompts for the password)
lsvault shares create vault_abc123 reports/Q1.md \
  --permission view \
  --protect-with-password \
  --expires 2026-12-31

# Publish a document
lsvault publish create vault_abc123 blog/post.md --slug my-first-post
```

### Publish Vault Commands

Publish a whole vault as a multi-document public site (Pro tier).

| Command | Description |
|---------|-------------|
| `lsvault publish-vault list` | List your published vault sites |
| `lsvault publish-vault publish <vaultId>` | Publish a vault as a public site |
| `lsvault publish-vault update <vaultId>` | Update a published vault site |
| `lsvault publish-vault unpublish <vaultId>` | Unpublish a vault site |

**Example:**
```bash
# Publish a vault as a public site
lsvault publish-vault publish vault_abc123 \
  --slug my-docs \
  --title "My Documentation" \
  --enable-search

# List published vault sites
lsvault publish-vault list

# Unpublish
lsvault publish-vault unpublish vault_abc123
```

### Hooks & Webhooks

| Command | Description |
|---------|-------------|
| `lsvault hooks list <vaultId>` | List vault hooks |
| `lsvault hooks create <vaultId> <name>` | Create a new hook |
| `lsvault hooks delete <vaultId> <hookId>` | Delete a hook |
| `lsvault hooks executions <vaultId> <hookId>` | View hook execution history |
| `lsvault webhooks list <vaultId>` | List vault webhooks |
| `lsvault webhooks create <vaultId> <url>` | Create a new webhook |
| `lsvault webhooks update <vaultId> <webhookId>` | Update webhook configuration |
| `lsvault webhooks delete <vaultId> <webhookId>` | Delete a webhook |

**Example:**
```bash
# Create a hook that runs an AI prompt on document creation
lsvault hooks create vault_abc123 "Auto-tag" \
  --trigger document.created \
  --action ai_prompt \
  --config '{"prompt":"Suggest tags"}'

# Create a webhook for document updates
lsvault webhooks create vault_abc123 https://api.example.com/webhook \
  --events document.created,document.updated
```

### Calendar

| Command | Description |
|---------|-------------|
| `lsvault calendar view <vaultId>` | Browse calendar views and activity heatmap |
| `lsvault calendar due <vaultId>` | List documents by due date |
| `lsvault calendar set-due <vaultId> <path> --date <date>` | Set or clear a document due date (pass `--date clear` to clear) |
| `lsvault calendar events <vaultId>` | List calendar events |
| `lsvault calendar event create <vaultId> <title>` | Create a calendar event |
| `lsvault calendar event update <vaultId> <eventId>` | Update a calendar event |
| `lsvault calendar event delete <vaultId> <eventId>` | Delete a calendar event |

### Booking Commands

Manage bookable event slots and guest bookings. Slot CRUD requires Pro tier; team booking groups and waitlist require Business tier.

| Command | Description |
|---------|-------------|
| `lsvault booking slots list <vaultId>` | List all event slots for a vault |
| `lsvault booking slots create <vaultId>` | Create a new bookable event slot |
| `lsvault booking slots update <vaultId> <slotId>` | Update an event slot |
| `lsvault booking slots delete <vaultId> <slotId>` | Delete an event slot |
| `lsvault booking list <vaultId>` | List bookings for a vault |
| `lsvault booking confirm <vaultId> <bookingId>` | Confirm a pending booking |
| `lsvault booking cancel <vaultId> <bookingId>` | Cancel a booking |
| `lsvault booking reschedule <token> <newStartAt>` | Reschedule via guest token |
| `lsvault booking analytics <vaultId>` | View booking analytics (Business tier) |
| `lsvault booking templates list <vaultId>` | List event templates |
| `lsvault booking templates create <vaultId>` | Create an event template |
| `lsvault booking templates delete <vaultId> <templateId>` | Delete an event template |
| `lsvault booking groups list <teamId>` | List team booking groups |
| `lsvault booking groups create <teamId>` | Create a team booking group |
| `lsvault booking groups update <teamId> <groupId>` | Update a team booking group |
| `lsvault booking groups delete <teamId> <groupId>` | Delete a team booking group |
| `lsvault booking group-members list <teamId> <groupId>` | List booking group members |
| `lsvault booking group-members add <teamId> <groupId>` | Add member to booking group |
| `lsvault booking group-members remove <teamId> <groupId> <userId>` | Remove member from group |
| `lsvault booking waitlist list <vaultId> <slotId>` | List waitlist entries for a slot |

### AI Commands

| Command | Description |
|---------|-------------|
| `lsvault ai sessions list` | List AI chat sessions |
| `lsvault ai sessions get <sessionId>` | Get session with messages |
| `lsvault ai sessions delete <sessionId>` | Delete an AI chat session |
| `lsvault ai chat <sessionId> <message>` | Send a message in a session |
| `lsvault ai summarize <vaultId> <docPath>` | Summarize a document with AI |

**Example:**
```bash
# Chat with AI
lsvault ai chat session_abc123 "Summarize the key points"

# Summarize a document
lsvault ai summarize vault_abc123 notes/meeting.md
```

### Analytics Commands

| Command | Description |
|---------|-------------|
| `lsvault analytics published` | Summary of published document views |
| `lsvault analytics share <vaultId> <shareId>` | Analytics for a share link |
| `lsvault analytics doc <vaultId> <publishedDocId>` | Analytics for a published document |

### Custom Domain Commands

| Command | Description |
|---------|-------------|
| `lsvault custom-domains list` | List custom domains |
| `lsvault custom-domains get <domainId>` | Get a custom domain |
| `lsvault custom-domains add <domain>` | Add a custom domain |
| `lsvault custom-domains update <domainId>` | Update a custom domain |
| `lsvault custom-domains remove <domainId>` | Remove a custom domain |
| `lsvault custom-domains verify <domainId>` | Verify domain via DNS TXT record |
| `lsvault custom-domains check <domainId>` | Check DNS configuration |

**Example:**
```bash
# Add a custom domain
lsvault custom-domains add docs.example.com

# Verify after adding DNS TXT record
lsvault custom-domains verify domain_abc123
```

### Links & Backlinks

| Command | Description |
|---------|-------------|
| `lsvault links list <vaultId> <path>` | List forward links from a document |
| `lsvault links backlinks <vaultId> <path>` | List backlinks pointing to a document |
| `lsvault links graph <vaultId>` | Get the link graph for a vault |
| `lsvault links broken <vaultId>` | List unresolved (broken) links in a vault |

**Example:**
```bash
# List forward links from a document
lsvault links list vault_abc123 notes/index.md

# Find all documents linking to a specific document
lsvault links backlinks vault_abc123 notes/important.md

# Get the full link graph for visualization
lsvault links graph vault_abc123 --output json > graph.json

# Find broken links
lsvault links broken vault_abc123
```

### Admin Commands

**Note:** Admin commands require admin role.

| Command | Description |
|---------|-------------|
| `lsvault admin users list` | List all users |
| `lsvault admin users get <userId>` | Get user details |
| `lsvault admin users update <userId>` | Update user (role, active status) |
| `lsvault admin stats` | View system statistics |
| `lsvault admin stats timeseries` | Show timeseries data for a metric |
| `lsvault admin activity` | Show recent system-wide activity |
| `lsvault admin subscriptions` | Show subscription tier distribution |
| `lsvault admin health` | Check system health (DB, Redis, uptime) |

**Example:**
```bash
# List all users (admin only)
lsvault admin users list

# View system stats
lsvault admin stats

# View system health
lsvault admin health
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
It reports success only after at least one valid sync is ready. Its default log is
`~/.lsvault/daemon/daemon.log`.

For systemd, launchd, or another process supervisor, use the foreground entrypoint:

```bash
lsvault sync daemon run
```

Configure the supervisor to restart that command on failure. Do not supervise
`daemon start`, because that command is only the short-lived detached launcher.

### Sync-root safety marker

Each initialized root contains `.lsvault-sync-root`, a hidden JSON identity file.
The CLI validates its sync ID and vault ID before scanning or making sync API
requests. If the directory is missing, unmounted, unreadable, unwritable, or has
the wrong marker, syncing fails closed; it is never treated as an empty vault.
A correctly marked directory with no Markdown files remains a valid intentional
empty root.

Configurations created by older CLI versions are intentionally untrusted until
you verify the path and run:

```bash
lsvault sync trust-root <syncId>
```

The daemon skips invalid roots, reports them in the daemon log, and continues
running any other valid configurations.

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

# Create a profile by setting a value in it (profiles are created on first use)
lsvault config set apiUrl https://vault.lifestreamdynamics.com --profile production

# Switch profiles
lsvault config use production

# Set config values (in the active profile)
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
| `LSVAULT_HTTP_TIMEOUT_MS` | SDK request timeout, 1000-300000 milliseconds | `30000` |

**Example:**
```bash
export LSVAULT_API_URL=https://vault.lifestreamdynamics.com
export LSVAULT_API_KEY=lsv_k_your_key_here
export LSVAULT_HTTP_TIMEOUT_MS=60000
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
lsvault search "quarterly report" --vault vault_abc123 -o json

# Create a share link for the found document
lsvault shares create vault_abc123 reports/Q4-2025.md \
  --permission view \
  --protect-with-password \
  --expires 2026-01-31

# Publish a document publicly
lsvault publish create vault_abc123 blog/announcement.md \
  --slug new-features-2026
```

### Team Collaboration Workflow

```bash
# Create a team
lsvault teams create "Product Team" --description "Product docs"

# Create a vault
lsvault vaults create "Product Docs" --description "Product documentation"

# Invite team members
lsvault teams invitations create team_abc123 pm@example.com --role admin
lsvault teams invitations create team_abc123 dev@example.com --role editor

# Configure a webhook for vault updates
lsvault webhooks create vault_xyz789 https://slack.example.com/webhook \
  --events document.created,document.updated
```

### Automation with API Keys

```bash
# Create a read-only API key for monitoring
lsvault keys create "Monitoring Script" \
  --scopes read \
  --expires 2026-12-31

# Use API key in scripts
export LSVAULT_API_KEY=lsv_k_generated_key
lsvault vaults list -o json | jq '.[] | .name'
```

## 🗒️ Release Notes

### 1.5.0 (unpublished — bundled with the 2026-09 service alignment)

- **Sync roots fail closed.** Every root now carries a `.lsvault-sync-root` identity marker. Sync configurations created by 1.4.x are untrusted until you verify the directory and run `lsvault sync trust-root <syncId>`; the daemon skips untrusted roots and logs them. This prevents a missing or unmounted directory from being pushed as a mass remote deletion.
- `lsvault sync init … --create-dir` creates a missing local directory; without the flag a missing directory is now an error.
- `lsvault sync daemon run` runs the daemon in the foreground for systemd/launchd supervision. Supervise `daemon run`, not `daemon start`.
- `LSVAULT_HTTP_TIMEOUT_MS` sets the SDK request timeout (default 30000, range 1000–300000).
- **Team vaults:** only team owners/admins can delete documents. A push from an editor account that deletes files reports the 403 per document and continues; the deletions are not retried. Vaults you are not a member of now return 404 instead of 403.
- Team vault storage moved server-side to `teams/<teamId>/<slug>`; the CLI is unaffected but a daemon host should upgrade only after running `trust-root` for each sync.

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

**Solution:** Use `-o json` (or `--output json`) or `--quiet` flags:
```bash
lsvault vaults list -o json
lsvault search "query" -o json | jq '.[] | .path'
lsvault docs get vault_abc123 path.md --quiet > output.md
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

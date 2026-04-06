# Proletariat Fork — Complete Usage Guide

> A comprehensive guide to the RShuken/proletariat fork, which adds 25+ features
> on top of the upstream `prlt` CLI. This guide assumes zero prior experience.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Agent Orchestration](#agent-orchestration)
- [Scheduler (Auto-Spawn)](#scheduler-auto-spawn)
- [Self-Healing Watchdog](#self-healing-watchdog)
- [Webhook Notifications](#webhook-notifications)
- [Web Dashboard](#web-dashboard)
- [REST API Reference](#rest-api-reference)
- [Agent-to-Agent Communication](#agent-to-agent-communication)
- [Session Management](#session-management)
- [Repository Management](#repository-management)
- [Cost Tracking](#cost-tracking)
- [Multi-User Setup](#multi-user-setup)
- [Migration Management](#migration-management)

---

## Quick Start

### Prerequisites

- macOS (tested on Mac Mini M-series)
- Node.js 24 LTS
- pnpm (`npm install -g pnpm`)
- tmux (`brew install tmux`)
- An Anthropic API key (`ANTHROPIC_API_KEY`)

### 1. Install and build

```bash
git clone git@github.com:RShuken/proletariat.git
cd proletariat
pnpm install
pnpm run build
```

The CLI is now available at `./apps/cli/bin/run.js`. To use it as `prlt`:

```bash
# Option A: alias in your shell profile
alias prlt="$(pwd)/apps/cli/bin/run.js"

# Option B: link globally
cd apps/cli && pnpm link --global
```

### 2. Create an HQ (headquarters)

An HQ is a workspace that holds your repositories, agents, projects, and database.

```bash
prlt new --name my-hq --path ~/AI/hq --repos git@github.com:user/repo.git
```

This creates `~/AI/hq/` with a `.prlt/` directory containing the workspace database, clones your repo, and sets up a default project with a ticket board.

Flags:
| Flag | Description |
|------|-------------|
| `--name, -n` | HQ name |
| `--path, -p` | Directory to create HQ in (defaults to `./{name}-hq`) |
| `--repos, -r` | Comma-separated repository URLs to clone |
| `--agents, -a` | Comma-separated agent names to create |
| `--no-pmo` | Skip project management setup |

### 3. Create your first ticket

```bash
cd ~/AI/hq
prlt ticket create --source pmo \
  -t "My first task" \
  -p P1 \
  --column Ready \
  -P my-project
```

This creates ticket `TKT-001` on the local PMO board in the **Ready** column with priority P1.

### 4. Spawn an agent

```bash
prlt work start TKT-001 \
  --run-on-host \
  --display background \
  --ephemeral \
  --skip-permissions \
  -y
```

| Flag | What it does |
|------|-------------|
| `--run-on-host` | Run directly on your machine (no Docker) |
| `--display background` | Detach into a tmux session |
| `--ephemeral` | Auto-generate a throwaway agent name |
| `--skip-permissions` | YOLO mode — agent auto-approves tool use |
| `-y` | Skip confirmation prompts |

### 5. Monitor your agent

```bash
# Live dashboard (refreshes every 5 seconds)
prlt monitor

# Peek at the last 50 lines of output
prlt peek swift-owl

# Send a message to a running agent
prlt poke swift-owl "Focus on the login endpoint first"
```

---

## Agent Orchestration

### Ticket lifecycle

Tickets flow through a Kanban board:

```
Backlog → Ready → In Progress → Review → Done
```

| Transition | How it happens |
|-----------|---------------|
| Backlog → Ready | Manual: `prlt ticket move TKT-001 Ready` |
| Ready → In Progress | Automatic when an agent starts work |
| In Progress → Review | Automatic when agent completes + PR opens |
| Review → Done | Automatic when PR merges |

### Spawning agents

The `prlt work start` command has many options. Here are the most common patterns:

```bash
# Basic: spawn an ephemeral agent on a ticket
prlt work start TKT-001 --ephemeral --run-on-host --display background -y

# Named agent on a ticket
prlt work start TKT-001 --agent swift-owl --display background -y

# With a custom prompt
prlt work start TKT-001 --prompt "Only modify the auth module" --ephemeral -y

# Append extra instructions to the default prompt
prlt work start TKT-001 --message "Skip writing tests for now" --ephemeral -y

# Start from a Linear issue (no local ticket needed)
prlt work start --from linear:ENG-123 --ephemeral --display background -y

# Start from a Jira issue
prlt work start --from jira:PROJ-456 --ephemeral --display background -y

# In a Docker container (default when devcontainer exists)
prlt work start TKT-001 --ephemeral --display background -y

# Batch: start all Ready tickets (respects max_agents)
prlt work start --all --max-parallel 3 -y

# Dry run: validate environment without actually spawning
prlt work start TKT-001 --dry-run
```

Key flags reference:

| Flag | Description |
|------|-------------|
| `--ephemeral` | Auto-generate agent name (no pre-registered agent needed) |
| `--agent <name>` | Use a specific named agent |
| `--display <mode>` | `foreground` (blocking), `terminal` (new tab), `background` (detached tmux) |
| `--run-on-host` | Skip Docker, run directly on host |
| `--skip-permissions` | Danger mode — auto-approve all tool use |
| `--permission-mode <mode>` | `danger` or `safe` |
| `--prompt <text>` | Custom prompt (replaces default action prompt) |
| `--message <text>` | Extra instructions appended to any prompt |
| `--repo <name>` | Specify which repo(s) to mount (repeatable) |
| `--clone` | Use independent git clone instead of worktree |
| `--create-pr` | Auto-create PR when work is ready |
| `--verify-ci` | Agent polls CI after push and fixes failures |
| `--review-gate <mode>` | `required`, `auto`, or `post` |
| `--keep-alive` | Keep container running after agent exits |
| `--cleanup <policy>` | `on-exit`, `persistent`, or `on-error-keep` |
| `--force` | Start even if work already in progress |
| `--all` | Start work on all unassigned Ready tickets |
| `--max-parallel <n>` | Max concurrent spawns in batch mode |
| `-y, --yes` | Skip confirmation prompts |

### Monitoring agents

```bash
# Live terminal dashboard (auto-refreshes)
prlt monitor
prlt monitor --interval 2        # Refresh every 2 seconds
prlt monitor --once              # Single snapshot, then exit
prlt monitor --json              # Machine-readable output

# List all sessions
prlt session list

# Peek at agent output (last 50 lines)
prlt peek swift-owl

# Send a nudge or instruction to a running agent
prlt poke swift-owl "Please also add unit tests"

# Attach to the agent's terminal (interactive)
prlt session attach swift-owl
prlt session attach swift-owl --new-tab    # Open in a new terminal tab

# Check session health
prlt session health swift-owl
```

The monitor dashboard shows for each agent:
- Agent name and current ticket
- Last 3 lines of output
- Git branch and uncommitted changes count
- Session uptime
- Context window usage (percentage + warning level)
- Detected status: `WORKING`, `IDLE`, `NEEDS_INPUT`, `ERROR`, `COMPLETE`

### Ending sessions and cleanup

```bash
# Stop an agent's work on a ticket
prlt work stop TKT-001

# Prune orphaned sessions (tmux sessions with no DB record)
prlt session prune

# Clean up Docker containers
prlt docker clean
prlt docker prune
```

---

## Scheduler (Auto-Spawn)

The scheduler automates the ticket-to-agent pipeline: when a ticket reaches **Ready** status, it spawns an agent automatically.

### How it works

```
Ticket moved to Ready
    ↓
Scheduler polls (every 30s) or receives event
    ↓
Capacity check: running agents < max_agents?
    ↓ Yes
Spawn agent on highest-priority Ready ticket
    ↓
Agent works → completes → slot freed
    ↓
Scheduler picks next Ready ticket
```

Priority ordering: `urgent > high/P1 > medium/P2 > low/P3 > none`

### Starting the orchestrator

The scheduler runs as part of the orchestrate daemon:

```bash
# Start with a preset (aggressive = fully autonomous)
prlt orchestrate --preset aggressive

# Conservative: human approves agent spawns
prlt orchestrate --preset conservative

# Supervised: LLM decides on destructive actions
prlt orchestrate --preset supervised --verbose

# With external polling (GitHub PRs, CI status)
prlt orchestrate --preset aggressive --poll-interval 60

# Load hooks from YAML config
prlt orchestrate --load-yaml --preset aggressive

# One-shot mode for CI integration
prlt orchestrate --once on_ci_green --pr 123
```

### Presets

| Preset | Agent spawning | Destructive actions | Best for |
|--------|---------------|-------------------|---------|
| `aggressive` | Automatic | Automatic | Fully autonomous operation |
| `conservative` | Human approval | Human approval | Cautious teams |
| `supervised` | LLM decides | LLM decides | Balanced autonomy |

### Configuration

| Setting | Key | Default | Description |
|---------|-----|---------|-------------|
| Max agents | `scheduler.max_agents` | `3` | Maximum concurrent agent sessions |
| Poll interval | `--poll-interval` flag | disabled | Seconds between external source polls |

### Orchestrator management

```bash
# Using the orchestrator subcommands
prlt orchestrator start              # Start the daemon
prlt orchestrator attach             # Attach to orchestrator terminal
prlt orchestrator status             # Show current status
prlt orchestrator stop               # Stop the daemon
```

### Hook events the scheduler reacts to

| Event | Scheduler action |
|-------|-----------------|
| `on_ticket_ready` | Spawn agent if capacity available |
| `on_agent_completed` | Free slot, schedule next ticket |
| `on_agent_died` | Free slot, optionally respawn with retry |
| `on_ci_green` | Merge PR |
| `on_pr_merged` | Move ticket to Done |
| `on_changes_requested` | Spawn fix agent |

---

## Self-Healing Watchdog

The watchdog monitors all running agent sessions every 30 seconds and takes corrective action.

### What it detects and does

| Condition | Detection method | Action | Cooldown |
|-----------|-----------------|--------|----------|
| **Context exhaustion** | Parses Claude Code JSONL logs for token usage | Sends `/compact` to the tmux pane at 90% usage | 5 minutes |
| **Crash** | Detects dead tmux sessions | Restarts with `claude --resume` + same permissions | Immediate |
| **Stuck agent** | No new output for 5+ minutes | Sends a poke: "Are you still working?" | 5 minutes |
| **Permission prompt** | Pattern-matches approval prompts | Auto-sends `y` in danger mode | 10 seconds |

### Context auto-compact

The watchdog reads each agent's Claude Code session log to track token usage:

- At **80%** of the model's context window: logs a warning
- At **90%**: sends `/compact` to the agent's tmux pane to free up context

Context window sizes:

| Model | Context window |
|-------|---------------|
| claude-opus-4-6 | 1,000,000 tokens |
| claude-sonnet-4-6 | 200,000 tokens |
| claude-haiku-4-5 | 200,000 tokens |

### Crash recovery

When a tmux session dies unexpectedly:

1. Watchdog detects the missing session
2. Restarts with `claude --resume` to continue from where the agent left off
3. If the agent was in danger mode, re-applies `--dangerously-skip-permissions`
4. Tracks restarted executions to avoid infinite restart loops

### YOLO auto-response

In danger/YOLO mode, the watchdog auto-responds to common stuck prompts:

| Prompt type | Example | Auto-response |
|-------------|---------|---------------|
| Permission/Safety | "Do you want to proceed?" | `y` (danger mode only) |
| Continue | "Would you like me to continue?" | `yes` (always) |
| Plan approval | "Start implementation?" | `yes` (danger mode only) |
| Model selection | "Which model?" | Never auto-responds |

### Configuration

All settings are stored in `workspace_settings`:

| Setting | Key | Default | Description |
|---------|-----|---------|-------------|
| Master switch | `watchdog.enabled` | `true` | Enable/disable all watchdog features |
| Context detection | `watchdog.context_detection` | `true` | Monitor token usage |
| Crash recovery | `watchdog.crash_recovery` | `true` | Auto-restart dead sessions |
| Stuck detection | `watchdog.stuck_detection` | `true` | Detect idle agents |
| Auto-permit | `watchdog.auto_permit` | `true` | Auto-approve permission prompts |
| Context threshold | `watchdog.context_threshold` | `0.20` | Remaining capacity ratio that triggers compact |
| Stuck timeout | `watchdog.stuck_timeout_secs` | `300` | Seconds of no output before poke (5 min) |
| Auto-respond enabled | `auto_respond.enabled` | `true` | Auto-respond to stuck prompts in danger mode |
| Auto-respond cooldown | `auto_respond.cooldown_secs` | `10` | Seconds between auto-responses per session |

---

## Webhook Notifications

Get real-time notifications when agent events occur.

### Setup

```bash
# Interactive wizard
prlt notify setup

# Non-interactive with Slack
prlt notify setup \
  --url https://hooks.slack.com/services/T.../B.../xxx \
  --format slack

# With HMAC signing secret
prlt notify setup \
  --url https://example.com/webhook \
  --secret my-signing-key

# ntfy.sh (generic format, no signing)
prlt notify setup --url https://ntfy.sh/my-agents --skip-test

# Discord webhook
prlt notify setup --url https://discord.com/api/webhooks/123/abc --format generic
```

### Setup flags

| Flag | Description |
|------|-------------|
| `--url <url>` | Webhook endpoint to POST notifications to |
| `--format <format>` | Payload format: `generic` (default) or `slack` |
| `--secret <secret>` | HMAC-SHA256 signing secret (`X-Webhook-Signature` header) |
| `--name <name>` | Provider name (default: `webhook`) |
| `--skip-test` | Skip the test ping after saving config |

### Events that trigger notifications

These are auto-wired on setup:

| Event | When it fires |
|-------|--------------|
| `on_agent_completed` | Agent finished its work |
| `on_agent_died` | Agent session crashed |
| `on_agent_idle` | Agent has no more work |
| `on_agent_needs_input` | Agent is blocked waiting for human input |

### Managing notification rules

```bash
# Add a rule for a specific event
prlt notify rules add --event on_ci_failed --provider webhook

# List all rules
prlt notify rules list

# Remove a rule
prlt notify rules remove <rule_id>

# Test that notifications are working
prlt notify test

# Disconnect/reconnect
prlt notify disconnect
prlt notify connect

# List configured providers
prlt notify list
```

### Payload format (generic)

```json
{
  "event": "on_agent_completed",
  "agent": "swift-owl",
  "ticket": "TKT-042",
  "timestamp": "2026-04-06T12:00:00Z",
  "details": { }
}
```

For Slack format, the payload is wrapped in Block Kit `blocks` structure with headers and fields.

### Webhook security

When a `--secret` is configured, every POST includes:

```
X-Webhook-Signature: sha256=<HMAC-SHA256 of body>
```

Verify this on your server to ensure payloads are authentic.

### Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `webhook.url` | — | POST endpoint |
| `webhook.enabled` | `false` | Enable/disable |
| `webhook.format` | `generic` | `generic` or `slack` |
| `webhook.secret` | — | HMAC-SHA256 signing secret |

---

## Web Dashboard

A browser-based dashboard with real-time agent status, ticket board, and live output peek.

### Starting the dashboard

```bash
# Start on default port (3000)
prlt web

# Custom port
prlt web --port 8080

# Don't auto-open browser
prlt web --no-open
```

### What you see

- **Agent status cards** — name, ticket, status, uptime, token usage, context window %
- **Kanban board** — tickets in columns (Backlog, Ready, In Progress, Review, Done) with priority badges
- **Live output peek** — last 20 lines of each running agent's terminal, auto-refreshing
- **Sessions table** — session ID, ticket, agent, environment, status
- **Pull requests** — open PRs with CI status (success/failure/pending)
- **Send input** — type a message to any running agent directly from the browser

### Real-time updates

The dashboard uses WebSocket for live updates every 3 seconds. No page refresh needed.

### Mobile access via Tailscale

If your Mac Mini is on a Tailscale network:

```bash
# Start on all interfaces
prlt web --port 3000

# Access from phone/tablet
# https://mac-mini.tailnet-name:3000
```

---

## REST API Reference

The web dashboard exposes a REST API. All endpoints support CORS (`Access-Control-Allow-Origin: *`).

### Dashboard data

```
GET /api/data
```

Returns a complete dashboard snapshot: agents, board, sessions, PRs, token usage.

### Sessions

```
GET /api/sessions
```

List all running sessions with status, agent name, ticket, and environment.

**Response:**
```json
{
  "sessions": [
    {
      "sessionId": "prlt-TKT-001-swift-owl",
      "ticketId": "TKT-001",
      "agentName": "swift-owl",
      "status": "running",
      "environment": "host",
      "source": "db"
    }
  ]
}
```

---

```
GET /api/sessions/:name/peek?lines=50&format=json
```

Capture last N lines from an agent's tmux pane.

| Query param | Default | Description |
|-------------|---------|-------------|
| `lines` | `50` | Number of lines (1-500) |
| `format` | `json` | `json` or `text` |

**Response (json):**
```json
{
  "sessionId": "prlt-TKT-001-swift-owl",
  "agentName": "swift-owl",
  "lines": ["line 1", "line 2", "..."]
}
```

---

```
POST /api/sessions/:name/send
Content-Type: application/json

{ "text": "yes" }
```

Send text (keystrokes) to a running agent's tmux session.

**Response:**
```json
{ "ok": true, "sessionId": "prlt-TKT-001-swift-owl" }
```

---

### Board / Task claiming

Agents can claim tickets atomically to avoid collisions.

```
GET /api/board/available
```

List unassigned tickets ready for work, sorted by priority.

**Response:**
```json
{
  "success": true,
  "tickets": [
    { "id": "TKT-005", "title": "Fix login bug", "priority": "P1", "statusName": "Ready" }
  ]
}
```

---

```
POST /api/board/:ticketId/claim
Content-Type: application/json

{ "agent_name": "swift-owl" }
```

Atomically claim a ticket. Returns **409 Conflict** if already claimed.

**Success (200):**
```json
{ "success": true, "ticket": { "id": "TKT-005", "title": "Fix login bug", "assignee": "swift-owl" } }
```

**Conflict (409):**
```json
{ "success": false, "error": "Ticket already claimed by bold-fox", "claimed_by": "bold-fox" }
```

---

```
POST /api/board/:ticketId/release
Content-Type: application/json

{ "agent_name": "swift-owl" }
```

Release a ticket claim. Only the claiming agent can release.

---

```
POST /api/claim-task
Content-Type: application/json

{ "agent_name": "swift-owl", "ticket_id": "TKT-005" }
```

Claim a specific ticket, or omit `ticket_id` to auto-claim the next available:

```json
{ "agent_name": "swift-owl", "status_filter": "ready" }
```

---

## Agent-to-Agent Communication

Agents can send messages to each other through a durable message queue.

### Send a message

```bash
# Operator sends to an agent
prlt msg send swift-owl "The auth endpoint changed to /v2/login"

# Agent-to-agent (specify sender)
prlt msg send swift-owl "Check the new schema" --from bold-eagle
```

### List messages

```bash
# List pending messages for the current agent
prlt msg list

# List for a specific agent
prlt msg list --agent swift-owl

# Include already-read messages
prlt msg list --agent swift-owl --all

# Mark messages as read after listing
prlt msg list --agent swift-owl --mark-read
```

### Broadcast to all agents

```bash
# Send to every active agent
prlt msg broadcast "Deploy freeze starts in 30 minutes"

# With explicit sender
prlt msg broadcast "New API keys rotated" --from operator
```

Broadcast finds all agents with active tmux sessions and enqueues a message to each (excluding the sender).

### How delivery works

- Messages are stored in the `message_queue` database table
- The orchestrate daemon delivers messages every **5 seconds**
- Delivery sends the message text as keystrokes to the agent's tmux pane
- Messages have status tracking: `pending` → `delivered`

### REST API for programmatic messaging

Agents can also coordinate via the REST API:

```bash
# From inside an agent, send to another agent's session
curl -X POST http://localhost:3000/api/sessions/bold-eagle/send \
  -H "Content-Type: application/json" \
  -d '{"text": "I finished the API, your turn"}'

# Check available tickets
curl http://localhost:3000/api/board/available

# Claim a ticket atomically
curl -X POST http://localhost:3000/api/board/TKT-005/claim \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "swift-owl"}'
```

### MCP tool for messaging

Agents running Claude Code can use the prlt MCP server to send and receive messages programmatically without shelling out to the CLI.

---

## Session Management

### User-scoped sessions

Sessions are prefixed with the current user's name to prevent collisions:

```
alice--TKT-042-Implement-swift-owl
bob--TKT-043-Review-bold-eagle
```

Set the user identity:

```bash
# Explicit override
export PRLT_USER=alice

# Defaults to $USER or os.userInfo().username
```

Commands like `prlt monitor` and `prlt session list` auto-filter to the current user.

### Session forking

Fork a running session to a new branch with its full conversation history:

```bash
# Fork to auto-generated branch
prlt session fork swift-owl

# Specify a name for the forked session
prlt session fork swift-owl --new-name swift-owl-v2

# Specify the branch name
prlt session fork swift-owl -b feat/alternative-approach
```

This creates a new git worktree and a new tmux session with the forked agent's conversation context.

### Status detection

The monitor automatically detects each agent's status:

| Status | Meaning |
|--------|---------|
| `WORKING` | Agent is actively producing output |
| `IDLE` | No recent activity |
| `NEEDS_INPUT` | Waiting for user/permission response |
| `ERROR` | Session encountered an error |
| `COMPLETE` | Work finished successfully |

### Session commands reference

```bash
prlt session list                          # List all sessions
prlt session attach <agent>                # Attach to a session
prlt session attach <agent> --new-tab      # Open in new terminal tab
prlt session peek <agent>                  # Last 50 lines of output
prlt session poke <agent> "message"        # Send a message
prlt session health <agent>                # Check health status
prlt session inspect <session_id>          # Detailed inspection
prlt session fork <agent>                  # Fork to new branch
prlt session restart <agent>               # Restart session
prlt session watch <agent>                 # Watch in real-time
prlt session report <agent> --status done  # Report lifecycle event
prlt session prune                         # Remove orphaned sessions
prlt session cost                          # Token cost summary
```

---

## Repository Management

### Adding repositories

```bash
# Clone from GitHub
prlt repo add git@github.com:user/repo.git

# Register an existing local checkout (no clone)
prlt repo add --path /home/user/projects/my-repo

# Add multiple repos interactively
prlt repo add --bulk

# Move a repo into the HQ (instead of cloning)
prlt repo add /path/to/repo --action move
```

### Listing and managing repos

```bash
prlt repo list                    # List all registered repos
prlt repo view my-repo            # Show repo details
prlt repo remove my-repo          # Unregister a repo
prlt repo fix-remotes             # Fix broken git remotes
```

### Smart repo mounting per ticket

Tickets can declare which repos they need:

```bash
# Create a ticket that needs specific repos
prlt ticket create --title "Cross-repo refactor" \
  --repo openagent-connect \
  --repo openagent-core

# When an agent starts, only declared repos are mounted
prlt work start TKT-001 --ephemeral -y

# Override with explicit repos at start time
prlt work start TKT-001 --repo specific-repo --ephemeral -y
```

Resolution order:
1. `--repo` flag on `work start` (if provided)
2. Repos declared on the ticket
3. Interactive selection (fallback)

Worktrees are the default mount mode. Use `--clone` for full isolation.

---

## Cost Tracking

### Per-session token tracking

Every agent session tracks:
- Input tokens
- Output tokens
- Cache read tokens
- Cache creation tokens
- Estimated cost in USD

### Viewing costs

```bash
# Last 30 days (default)
prlt session cost

# Last 7 days
prlt session cost --days 7

# Filter by agent
prlt session cost --agent swift-owl

# JSON output for scripting
prlt session cost --json
```

### Example output

```
Date         Sessions  Input     Output    Cache Read  Cost
2026-04-06   5         150,000   75,000    25,000      $2.45
2026-04-05   8         280,000   140,000   50,000      $4.60
─────────────────────────────────────────────────────────────
Total        13        430,000   215,000   75,000      $7.05
```

### JSON output format

```json
{
  "days": [
    {
      "date": "2026-04-06",
      "sessionCount": 5,
      "inputTokens": 150000,
      "outputTokens": 75000,
      "cacheReadTokens": 25000,
      "cacheCreationTokens": 10000,
      "estimatedCostUsd": 2.45
    }
  ],
  "totals": {
    "sessionCount": 150,
    "inputTokens": 4500000,
    "outputTokens": 2250000,
    "estimatedCostUsd": 73.50
  }
}
```

### Web dashboard

The web dashboard (`prlt web`) shows token usage and cost per agent in the agent status cards, updated in real-time.

---

## Multi-User Setup

Multiple users can share a single prlt workspace (e.g., on a shared Mac Mini) with full session isolation.

### How user scoping works

Sessions are prefixed with the username:

```
alice--TKT-042-Implement-swift-owl
bob--TKT-043-Review-bold-eagle
```

This prevents tmux session name collisions and lets commands filter by user.

### Setting up SSH access for colleagues

1. **Create SSH accounts** on the Mac Mini for each user
2. **Point everyone to the same HQ:**
   ```bash
   # In each user's .bashrc / .zshrc
   export PRLT_USER="alice"
   export ANTHROPIC_API_KEY="sk-ant-..."
   cd ~/AI/hq   # shared HQ directory
   ```
3. **Each SSH session** automatically gets its own `$USER` or `PRLT_USER`

### Isolation guarantees

| Layer | Isolation mechanism |
|-------|-------------------|
| Sessions | User-prefixed tmux session names |
| Git | Each agent gets its own worktree |
| Docker | Agent-specific container mounts and credentials |
| Database | SQLite WAL mode enables concurrent reads/writes |
| Credentials | Per-user SSH keys and API keys |

### Shared ticket board

All users share the same ticket board. Ticket claiming is atomic (compare-and-swap), so two agents cannot claim the same ticket simultaneously.

### Cross-user messaging

Messages work across user boundaries. `prlt msg send` and `prlt msg broadcast` deliver to any agent regardless of which user owns the session.

```bash
# Alice can message Bob's agent
prlt msg send bold-eagle "Schema migration is ready for you"
```

---

## Migration Management

### Creating a new migration

Use the helper script to create numbered migration files:

```bash
# From the repo root
./scripts/new-migration.sh add_user_preferences

# Or via pnpm
pnpm new-migration add_user_preferences
```

This script:
1. Scans existing migrations to find the highest number
2. Creates a new file: `apps/cli/src/lib/database/migrations/0029_add_user_preferences.ts`
3. Auto-registers the import and array entry in `index.ts`

### Migration file structure

```typescript
import type { Migration } from '../types.js';
import type Database from 'better-sqlite3';

export const migration: Migration = {
  id: '0029',
  name: 'add_user_preferences',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  },
};
```

### Auto-migration on HQ open

Migrations run automatically when the workspace database is opened. There is no manual `migrate` command — opening any prlt command that touches the database will apply pending migrations.

### Current migrations (28 total)

The fork includes migrations for:
- Core workspace and PMO tables
- Work hooks and workflow rules
- Agent lifecycle tracking
- Orchestrator hooks
- Notification system and webhook providers
- Token tracking
- Message queue
- Watchdog and auto-responder settings
- Ticket-repo relationships

### Rules for migrations

- **Every schema change MUST have a migration.** Never modify the schema with raw SQL outside of migrations.
- **All database access MUST go through the DAL** (`src/lib/database/index.ts`). Never import `better-sqlite3` directly.
- Migrations are idempotent — safe to re-run.

---

## Appendix: Common Workflows

### Fully autonomous mode

Set up a fully automated pipeline where tickets flow from Ready to Done without human intervention:

```bash
# 1. Create HQ and add repos
prlt new --name prod-hq --path ~/AI/hq --repos git@github.com:org/repo.git

# 2. Set up notifications
prlt notify setup --url https://hooks.slack.com/services/T.../B.../xxx --format slack

# 3. Create tickets
prlt ticket create -t "Implement user auth" -p P1 --column Ready -P my-project
prlt ticket create -t "Add pagination to API" -p P2 --column Ready -P my-project
prlt ticket create -t "Fix date parsing bug" -p P1 --column Ready -P my-project

# 4. Start the orchestrator with aggressive preset
prlt orchestrate --preset aggressive --poll-interval 60 --verbose

# 5. Monitor from another terminal
prlt monitor

# 6. Or open the web dashboard
prlt web
```

The orchestrator will:
- Spawn agents for Ready tickets (up to `max_agents`)
- Move tickets through the board automatically
- Auto-restart crashed agents
- Compact context when agents run low
- Merge PRs when CI is green
- Notify you on Slack for key events
- Pick up the next ticket when an agent finishes

### Manual mode (one ticket at a time)

```bash
# Create and work on a single ticket
prlt ticket create -t "Fix the login bug" -p P1 --column Ready -P my-project
prlt work start TKT-001 --ephemeral --run-on-host --display foreground --skip-permissions -y

# Watch it work in your terminal
# When done, the agent exits and you review the changes
```

# 4C Fork Roadmap -- RShuken/proletariat (develop branch)

> **Date:** 2026-04-05
> **Author:** Ryan Shuken
> **Branch:** develop (RShuken/proletariat)
> **Upstream:** chrismcdermut/proletariat (main, synced 2026-04-05)
> **Target environment:** Mac Mini 4C (headless, multi-user SSH access)
> **Execution:** All work done ON 4C via prlt agents spawned from this HQ

## Goal

Make proletariat the production-ready agent orchestration platform for 4C Mac Mini -- fixing the bugs we hit during setup, adding the features we need for unattended multi-agent operation, and incorporating the best ideas from amux and claude-squad.

## How This Work Gets Done

This spec lives in `specs/product/4c-fork-roadmap.md` inside the proletariat fork itself. Tickets are created in Linear (RShuken workspace, team RSH) and synced to prlt on 4C. Agents on 4C pick up tickets and implement them against this very codebase -- prlt improves itself.

The proletariat fork lives at `~/AI/proletariat/` on 4C (develop branch). The HQ at `~/AI/hq/` manages project repos (OAC, etc.), but prlt development happens directly in `~/AI/proletariat/` using claude-squad or standalone Claude Code sessions.

---

## Phase 1: Bug Fixes (Day 1)

### 1.1 SQLite WAL mode
- **Problem:** Default SQLite journal mode causes SQLITE_BUSY when multiple users run prlt commands simultaneously
- **Fix:** Add `PRAGMA journal_mode=WAL` to database initialization
- **Files:** Database init code in `apps/cli/src/` (wherever better-sqlite3 is opened)
- **Acceptance:** Two concurrent `prlt ticket list` commands never error

### 1.2 Fix `prlt poke` session lookup
- **Problem:** `prlt poke <agent-name>` returns SESSION_NOT_FOUND even when `prlt session list` shows the agent as running
- **Evidence:** Tested with agents even-collison and deep-pichai -- both showed in session list but poke could not find them
- **Fix:** Session lookup in poke command uses different query than session list -- unify the lookup logic
- **Files:** `apps/cli/src/commands/poke.ts` or equivalent, session query logic
- **Acceptance:** `prlt poke <agent> "message"` works for any agent shown in `prlt session list`

### 1.3 Fix `gh` auth detection message
- **Problem:** `prlt work start` says "PR creation is DISABLED (gh CLI not available)" even when gh is installed
- **Root cause:** gh token was expired, but message says "not available" instead of "not authenticated"
- **Fix:** Differentiate "gh not installed" from "gh not authenticated" in the warning. Suggest `gh auth login` when auth is the issue.
- **Acceptance:** Clear, actionable error message when gh is installed but not authenticated

### 1.4 Auto-cleanup worktrees on ticket completion
- **Problem:** Killed tmux sessions leave orphaned worktrees and agent directories. We manually cleaned 3 during testing.
- **Fix:** Two mechanisms:
  - `prlt ticket move <id> Done` should clean up that ticket's worktrees and agent dirs
  - `prlt gc` should find and remove orphaned worktrees with no running session
- **Acceptance:** After moving a ticket to Done, no orphaned worktrees or agent dirs remain

### 1.5 Fix notification Stop hook JSON parse error
- **Problem:** claude-notifications handle-hook Stop crashes with JSON parse error when session terminates abnormally (tmux kill-session)
- **Fix:** Ensure hook data is always valid JSON regardless of how the session ends, or wrap hook invocation in error handling
- **Acceptance:** Notification Stop hook does not crash on abnormal termination

---

## Phase 2: Core Features (Week 1-2)

### 2.1 Webhook notifications
- **Problem:** Headless Mac Mini cannot show desktop notifications. Only way to know an agent needs attention is manual checking.
- **Feature:** `prlt notify` webhook system that POSTs to Slack/Discord/ntfy when:
  - Agent completes a ticket
  - Agent encounters an error
  - Agent asks a question (needs human input)
  - Agent idle for > N minutes
- **Config:** `prlt notify setup` interactive wizard, stores webhook URL in workspace settings
- **Inspiration:** claude-notifications-go webhook format, amux notification system
- **Acceptance:** Agent finishes -> Slack message within 10 seconds

### 2.2 Ticket scheduler (auto-advance Ready to In Progress)
- **Problem:** Human must manually run `prlt work start` for every ticket. No automation.
- **Feature:** Add scheduling to `prlt orchestrate`:
  - on_agent_complete: auto-start next Ready ticket if under concurrency limit
  - on_ticket_ready: auto-spawn agent after configurable delay
  - max_agents setting (default 3)
  - Priority-based ticket ordering
- **Inspiration:** amux atomic task claiming, capacity-based scheduling
- **Acceptance:** Move ticket to Ready, agent auto-spawns within 60 seconds (if under limit)

### 2.3 User-scoped sessions
- **Problem:** Multiple SSH users could have agent name and tmux session collisions
- **Fix:** Prefix session names with $USER or configurable identity
- **Acceptance:** Two users spawn agents simultaneously without collision

### 2.4 Token/cost tracking per session
- **Problem:** No visibility into API spend per agent
- **Feature:** Track token usage per session (input, output, cache), daily aggregation
- **Inspiration:** amux per-session token tracking
- **Acceptance:** `prlt session inspect <agent>` shows token usage and estimated cost

---

## Phase 3: Dashboard and UX (Week 3-4)

### 3.1 Upgrade `prlt web` dashboard
- **Problem:** Current `prlt web` is basic/read-only
- **Feature:** Real-time WebSocket dashboard:
  - Agent status cards (working / idle / needs input / error)
  - Token usage per agent
  - Ticket board
  - Live tmux output peek
  - Mobile responsive for phone access via Tailscale
- **Inspiration:** amux PWA dashboard
- **Acceptance:** Open dashboard from phone, see all agents and status

### 3.2 Built-in agent monitor
- **Problem:** We built a custom shell script (`agent-monitor`) as a stopgap
- **Feature:** `prlt monitor` -- TUI showing all running agents, last output, notification events, git status. Updates every 5 seconds.
- **Acceptance:** `prlt monitor` shows clean terminal dashboard over SSH

### 3.3 Smart repo mounting per ticket
- **Problem:** Agent spawn creates worktrees for ALL HQ repos even if ticket only affects one
- **Feature:** Tickets declare `repos: [openagent-connect]`, only those get mounted
- **Default:** Mount all if not specified (backward compatible)
- **Acceptance:** Only declared repos get worktrees on agent spawn

---

## Phase 4: Integration (Month 2)

### 4.1 Linear integration on 4C
- **Setup:** `prlt linear connect` on Mac Mini
- **Workflow:** Linear issues -> `prlt sync` -> prlt tickets -> scheduler auto-spawns agents
- **Acceptance:** Create Linear issue, appears in `prlt ticket list` within 60 seconds

### 4.2 Self-healing watchdog
- **Problem:** Agents get stuck on context exhaustion, API errors, permission prompts
- **Feature:** Watchdog monitors sessions:
  - Auto-compact context at 20% remaining
  - Restart on crash
  - Auto-respond to stuck prompts in YOLO mode
- **Inspiration:** amux self-healing watchdog
- **Acceptance:** Agent hitting context limit auto-compacts and continues

### 4.3 Agent-to-agent communication
- **Problem:** Agents are fully isolated, cannot coordinate
- **Feature:** REST API or message bus for inter-agent messaging
- **Inspiration:** amux /api/sessions/{name}/send
- **Acceptance:** Agent A sends message to Agent B via prlt API

---

## Non-Goals

- Language rewrite (Go/Rust) -- keep TypeScript, revisit at v1.0
- Docker/container support -- 4C runs on host, no overhead
- Replacing claude-squad -- cs stays installed for ad-hoc work
- Mobile app -- web dashboard via Tailscale is sufficient

---

## Success Criteria

After Phase 2, this end-to-end workflow works:

1. Ryan creates tickets in Linear from phone
2. `prlt sync` pulls tickets to 4C
3. Scheduler auto-spawns agents on Ready tickets (up to 3 concurrent)
4. Agents work in isolated worktrees, push branches, create PRs
5. Webhook notification hits Slack when each agent finishes
6. Ryan reviews PRs from phone, merges
7. `prlt gc` cleans up completed worktrees

Zero SSH required for the happy path.

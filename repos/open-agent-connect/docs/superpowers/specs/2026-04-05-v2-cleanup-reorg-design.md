# OpenAgent Connect v2 — Cleanup, Reorganization & Architecture Prep

**Date:** 2026-04-05
**Status:** Draft — awaiting review
**Goal:** Clean up legacy code, reorganize file structure, refactor monoliths, and prepare the codebase for multi-operator architecture.
**Motivation:** Make the codebase cleaner for day-to-day work and easier to onboard new operators/contributors. The next version introduces operator isolation (per-operator client lists, skill visibility, access boundaries), and the codebase needs to be clean before that work begins.

---

## 1. Legacy Code Removal

### Problem
`apps/control-plane/` is the original Express.js control plane, fully superseded by `apps/control-plane-cloudflare/` (Cloudflare Workers + Durable Objects). The legacy app is:
- Not in any CI/CD pipeline
- Not deployed anywhere
- Not imported by any other package
- Only referenced by a stale `dev:control-plane` script in root `package.json` and a mention in `README.md`

Having it in the repo creates confusion — during development, the wrong control plane has been accidentally referenced/modified.

`TODO.md` (MVP checklist, 88% done) and `TODO_CLOUDFLARE_V2.md` (100% complete) are no longer actionable and clutter the root.

### Changes
1. Delete `apps/control-plane/` entirely
2. Remove `"dev:control-plane"` script from root `package.json`
3. Remove `apps/control-plane/data/*` gitignore entries from `.gitignore`
4. Remove legacy control-plane mention from `README.md`
5. Move `TODO.md` → `docs/archive/TODO-mvp.md`
6. Move `TODO_CLOUDFLARE_V2.md` → `docs/archive/TODO-cloudflare-v2.md`

### Risk
Low. Git history preserves everything. No running system depends on the legacy app.

---

## 2. Control Plane Index Refactor

### Problem
`apps/control-plane-cloudflare/src/index.ts` is a **70KB monolith** containing all HTTP routing, request handling, auth checks, and endpoint logic in a single file. This makes it hard to navigate, review, and modify safely.

### Changes
Split into domain-specific route modules:

```
apps/control-plane-cloudflare/src/
├── index.ts                  # Entry point: middleware, route registration (~5KB)
├── routes/
│   ├── sessions.ts           # Session CRUD, verify, connect, commands, results
│   ├── devices.ts            # Enrollment, checkin, exec, results, health, WebSocket
│   ├── tokens.ts             # Token create, consume, revoke
│   ├── operators.ts          # Login, auth
│   └── install.ts            # Connect one-liner, platform installers
├── session-coordinator.ts    # Unchanged (Durable Object)
├── device-coordinator.ts     # Unchanged (Durable Object)
├── session-store.ts          # Unchanged (D1 queries)
├── auth.ts                   # Unchanged
├── audit-log.ts              # Unchanged
├── rate-limit.ts             # Unchanged
├── installers.ts             # Unchanged
├── agent-installers.ts       # Unchanged
└── terminal-ui.ts            # Unchanged
```

Each route module exports a handler function that receives the same context (env, store, request, url). `index.ts` becomes a thin router that dispatches to the right module.

### Constraints
- Pure structural refactor — no behavior changes
- All existing tests must pass without modification
- Cloudflare Worker entry point remains `src/index.ts`
- Shared helpers (error responses, JSON parsing, auth checks) stay in their existing files or get extracted to a `helpers.ts` if needed

---

## 3. Operator Console Refactor

### Problem
`apps/operator-console/src/index.ts` is a **40KB single file** containing CLI parsing, API client calls, auth logic, the assist flow, terminal rendering, and all command implementations.

### Changes
Split by responsibility:

```
apps/operator-console/src/
├── index.ts              # Entry point, CLI arg parsing (~3KB)
├── commands/
│   ├── assist.ts         # Main assist flow (largest piece)
│   ├── login.ts          # Auth / login
│   ├── session.ts        # Verify, connect, cmd, end, cancel
│   └── tokens.ts         # Token create, revoke, list
├── api-client.ts         # All HTTP calls to control plane
└── ui.ts                 # Terminal rendering, prompts, progress
```

### Constraints
- Pure structural refactor — no behavior changes
- Existing tests pass unchanged

---

## 4. Skills Directory Reorganization

### Problem
49 skill files sit flat in `skills/` with no subdirectory structure, despite CLAUDE.md already defining clear categories. Finding the right skill means scanning a long flat list.

### Changes
Reorganize into category subdirectories matching CLAUDE.md:

```
skills/
├── _deploy-common.md
├── _skill-authoring-guide.md
├── _skill-review.md
├── catalog.json
├── setup/
│   ├── setup-windows.md
│   ├── setup-macos.md
│   ├── setup-ubuntu-gce.md
│   └── token-optimization.md
├── foundation/
│   ├── deploy-identity.md
│   ├── deploy-messaging-setup.md
│   ├── deploy-prompt-guide.md
│   ├── deploy-security-safety.md
│   └── deploy-google-workspace.md
├── core-data/
│   ├── deploy-personal-crm.md
│   ├── deploy-knowledge-base.md
│   ├── deploy-memory.md
│   └── deploy-social-tracking.md
├── intelligence/
│   ├── deploy-advisory-council.md
│   ├── deploy-security-council.md
│   └── deploy-platform-health.md
├── automation/
│   ├── deploy-fathom-pipeline.md
│   ├── deploy-urgent-email.md
│   ├── deploy-daily-briefing.md
│   └── deploy-video-pipeline.md
├── operations/
│   ├── deploy-db-backups.md
│   ├── deploy-git-autosync.md
│   ├── deploy-health-monitoring.md
│   └── deploy-model-tracking.md
├── content/
│   ├── deploy-humanizer.md
│   ├── deploy-image-gen.md
│   ├── deploy-video-gen.md
│   ├── deploy-video-analysis.md
│   └── pipeline/
│       ├── deploy-content-pipeline.md
│       ├── deploy-tiktok-account-setup.md
│       ├── deploy-tiktok-warmup.md
│       ├── deploy-tiktok-compliance.md
│       ├── deploy-tiktok-posting.md
│       ├── deploy-youtube-posting.md
│       └── deploy-video-research.md
├── integrations/
│   ├── deploy-newsletter-crm.md
│   ├── deploy-asana.md
│   ├── deploy-earnings.md
│   └── deploy-food-journal.md
├── openclaw/                   # Already exists — unchanged
└── cora/                       # Already exists — unchanged
```

### Follow-up Updates
- Update CLAUDE.md skill catalog paths to use new subdirectory structure
- Update `catalog.json` with new paths
- Update any cross-references within skill files (e.g., "see deploy-identity.md" → "see foundation/deploy-identity.md")
- Update `_deploy-common.md` if it references specific skill paths

---

## 5. Docs Cleanup & Archival

### Problem
`docs/` contains 29 completed implementation plans, 11 resolved incident postmortems, finished V2 migration specs, and client-specific HTML explainers — all mixed together. Active reference material is hard to find among completed historical docs.

### Changes

**Archive completed work:**
```
docs/
├── archive/
│   ├── plans/                    # All 29 completed implementation plans
│   ├── issues/                   # All 11 resolved incident postmortems
│   ├── cloudflare-v2/            # 5 completed V2 migration specs
│   ├── TODO-mvp.md               # From root
│   └── TODO-cloudflare-v2.md     # From root
├── testing/
│   ├── FULL_SYSTEM_MANUAL_TEST_WALKTHROUGH.md
│   ├── PILOT_TEST_MATRIX.md
│   └── SMOKE_TEST_RESULTS.md
├── security/
│   └── nico-security-report-2026-03-12.md
├── guides/                       # Already exists — unchanged
├── gateway/                      # Already exists — unchanged
├── skills-menu/                  # Already exists — unchanged
├── project-explainer-site/       # Already exists — unchanged
└── superpowers/specs/            # New specs go here
```

**Move client-specific content to client folders:**
- `docs/cody-system-explainer.html` → `clients/cody-mcdonald/`
- `docs/lee-tuchfarber-explainer.html` → `clients/lee-tuchfarber/`
- `docs/michael-h-explainer.html` → `clients/michael-h/`
- `docs/nicole-incident-explainer.html` → `clients/nicole-glaros/`
- `docs/client-reports/michael-h/` → `clients/michael-h/reports/`

### Principle
Nothing gets deleted. Completed work moves to `archive/` so active `docs/` only contains current reference material.

---

## 6. Root Cleanup

### Problem
- `youtube-skills/` (1MB) — character definitions, ebook PDF, transcripts. Zero references from any code or config. Not a skill — orphaned project strategy docs.
- 7 `m9-*.png` files at root — milestone dashboard screenshots cluttering the project root.

### Changes
- Move `youtube-skills/` → `docs/archive/youtube-skills/`
- Move `m9-*.png` files → `docs/archive/milestones/`
- Update any README.md image references to new paths
- `data/` — leave as-is (gitignored runtime directory, working correctly)

---

## 7. CLAUDE.md Update

After all moves are complete, update CLAUDE.md to reflect:
- Removal of legacy control plane
- New skill paths with subdirectories
- Updated project structure section
- Remove references to stale TODO files

---

## 8. Known Issues to Address (Separately)

These came up during recent work and should be tracked but are **not part of this cleanup**:

### Agent Persistence Strategy
`caffeinate -i` is used in all macOS LaunchAgent plists to prevent idle sleep. This is wrong for laptops (overheating risk in bags). The real need is agent resilience (restart after kill, reconnect after wake), not preventing sleep. Needs a per-device-type strategy:
- **Laptops:** Rely on `KeepAlive > NetworkState` + `RunAtLoad` only. Let the Mac sleep naturally.
- **Desktops/headless:** `caffeinate` or `pmset` may be appropriate, discuss per client.
- **All:** The agent should self-heal regardless of sleep behavior.

---

## 9. Future Direction: Multi-Operator Architecture

This cleanup prepares the codebase for the next major feature: **operator isolation**. In the current system, there's a single operator (`owner-1`). The next version needs:

- **Operator-scoped client lists** — each operator can only access their assigned clients
- **Skill visibility** — shared skill catalog vs per-operator skills
- **Enrollment scoping** — devices enrolled by operator A are not accessible to operator B
- **Session isolation** — operators can only see/control their own sessions
- **Operator configuration** — where per-operator config lives (D1 tables, config files, or both)
- **Access control model** — simple ownership lists vs full RBAC

The route-splitting refactor (Section 2) directly enables this by making it easy to add auth/scoping middleware per route domain. The skills reorganization (Section 4) creates a structure that can later support per-operator skill directories.

These design questions are captured here for the next planning cycle. They are not in scope for this cleanup.

---

## Execution Order

The sections should be implemented in this order to minimize conflicts:

1. **Legacy removal** (Section 1) — reduces noise for everything else
2. **Root cleanup** (Section 6) — quick wins, fewer files to reason about
3. **Docs archival** (Section 5) — moves files out of the way
4. **Skills reorganization** (Section 4) — file moves + CLAUDE.md update
5. **Control plane refactor** (Section 2) — largest code change, benefits from clean context
6. **Operator console refactor** (Section 3) — independent of control plane
7. **CLAUDE.md update** (Section 7) — final pass after all moves are done

Each section is a single commit (or small series of commits) so progress is incremental and reversible.

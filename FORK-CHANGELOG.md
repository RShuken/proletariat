# RShuken/proletariat Fork Changelog

> Tracking all improvements made in the `develop` branch of RShuken/proletariat.
> Each feature is designed to be cherry-pickable back to chrismcdermut/proletariat.
> When ready, create individual PRs per feature for Chris to review.

## How to cherry-pick a feature to Chris's repo

```bash
# From a clone of chrismcdermut/proletariat:
git remote add rshuken git@github.com:RShuken/proletariat.git
git fetch rshuken develop
git cherry-pick <commit-hash>    # pick individual feature commits
```

## Completed Features

### Phase 1: Bug Fixes (2026-04-06)

| Commit | Ticket | Title | Cherry-pickable? |
|--------|--------|-------|-----------------|
| `c3924e5` | TKT-005 | SQLite WAL mode for concurrent access | Yes |
| `306d03a` | TKT-006 | Fix poke session lookup (unify with session list) | Yes |
| `5444e3a` | TKT-007 | Differentiate gh not-installed vs not-authenticated | Yes |
| `88253ef` | TKT-008 | Auto-cleanup worktrees when ticket moves to Done | Yes |
| `a00103d` | TKT-009 | Fix Stop hook JSON parse on abnormal termination | Yes |

### Phase 2: Core Features (2026-04-06)

| Commit | Ticket | Title | Cherry-pickable? |
|--------|--------|-------|-----------------|
| `56546fd` | TKT-010 | Webhook notification delivery (Slack/Discord/ntfy) | Yes |
| `279bb99` | TKT-011 | Ticket scheduler with auto-spawn on Ready | Yes |
| `72b1f74` | TKT-012 | User-scoped tmux sessions for multi-user | Yes |
| `15c545b` | TKT-013 | Per-session token usage tracking and cost reporting | Yes |

### Phase 3: Dashboard and UX (2026-04-06)

| Commit | Ticket | Title | Cherry-pickable? | Notes |
|--------|--------|-------|-----------------|-------|
| `376d5f3` | TKT-014 | Register repos at any local path (--path flag) | Yes | |
| `a8b1f02` | TKT-015 | Real-time WebSocket dashboard | Needs `ws` dep | Requires `pnpm add ws @types/ws` |
| `f646554` | TKT-016 | Built-in prlt monitor TUI command | Yes | |
| `4124ece` | TKT-017 | Smart repo mounting (tickets declare repos) | Yes | Adds migration 0025 |

### Phase 4: Integration (2026-04-06)

| Commit | Ticket | Title | Cherry-pickable? | Notes |
|--------|--------|-------|-----------------|-------|
| `afc4e90` | TKT-018 | Self-healing watchdog (context compact, crash recovery) | Yes | Adds migration 0026 |
| `612f8e5` | TKT-019 | Agent-to-agent messaging (queue, broadcast, MCP) | Needs review | Touches orchestrate and dashboard |

### Infrastructure fixes

| Commit | Description |
|--------|-------------|
| `be05c41` | Spec: 4C fork roadmap document |
| `90ca516` | Migration numbering conflict resolution (0023/0024) |

## Known Issues Found During Integration

1. **Migration numbering conflicts**: When multiple features add migrations in parallel, they pick the same number. Future features should check existing migration numbers before adding new ones.
2. **Database migration not auto-applied**: Adding schema columns in code doesn't auto-migrate the running database. Need to verify migrations run on existing HQs.
3. **TKT-015 (web dashboard) requires `ws` package**: Not declared in the original package.json by the agent. Had to add manually.

## Future Features (not yet implemented)

- Linear integration on 4C (needs interactive auth)
- Tailscale HTTPS for remote dashboard access
- End-to-end testing of all new features
- README/documentation updates for new commands

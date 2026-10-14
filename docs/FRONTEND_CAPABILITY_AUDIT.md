# Frontend capability audit

Implemented against the locally generated Codex **0.162.1** protocol, including experimental fields negotiated by the local stdio client. Generated files stay untracked. Actual isolated Codex tests, not documentation assumptions, verify protocol behavior. Availability still depends on the installed version, provider and account.

## Implemented surfaces

| Surface | Frontend | Authenticated daemon / native protocol |
| --- | --- | --- |
| Goal | Header target button/banner, objective, budget, tokens, elapsed time, pause/resume, edit and confirmed delete | `GET/PATCH/DELETE /api/threads/:id/goal`; native `thread/goal/get/set/clear`, user provenance, notifications and read-only external polling |
| Queue | Actual pending text, attachments and settings; cancel/edit/up/down, queue count shortcut | `GET/PATCH /api/threads/:id/queue`; serialized with Turn start/drain, stale reorder rejected, attachment/settings retention |
| Next-turn settings | Model-supported reasoning effort and service tier, native plan/default mode; per-thread browser persistence | Validated `turn/start` settings, `collaborationMode` built-in instructions; queued/retried messages retain choices |
| Effective runtime | Model/provider/effort/tier/mode/approval/sandbox; reroute source and reason | Normalized start/resume metadata and `thread/settings/updated` / `model/rerouted` notifications |
| Context | Last-turn context pressure separate from cumulative tokens, cache/reasoning counts, context capacity; confirmed compaction | `thread/tokenUsage/updated`, `thread/compact/start`, compaction items/completion; idle/ownership/queue guards and deployment activity tracking |
| Thread management | Ellipsis menu: rename, fork, archive or restore; archived/recent drawer, server-side title search and more pages | `thread/name/set`, `thread/fork`, archive/unarchive; `thread/list` cursor/search/archived filters; opening an archive does not resume it |
| Structured tools | Sub-agent threads/state/messages, safe search links, authenticated local or inline raster images, reviews, sleep/compaction | Explicit normalized timeline types instead of unknown raw objects; command exit codes and command/tool duration |
| Quotas | Reported used percentage/windows/reset time and ordinary-usage denial | `account/rateLimits/read`, sanitized quota buckets; no account identity, credits secrets or inferred unlimited access |
| Inventories | MCP state/tool count, Skills enabled state, installed plugin state, Hook trust/handler type; manual and visible minute refresh | Read-only `mcpServerStatus/list` (pagination), `skills/list`, `plugin/installed`, `hooks/list`; whitelisted fields, summarized errors, no raw commands/credentials |
| Browser safety | Shared mobile/desktop panels, both themes, bounded/collapsible timeline, strict frontend typecheck | `npm run typecheck`, unit/browser/native integration coverage, error paths keep app visible |

## Semantics and boundaries

- Goal off means paused, retaining objective. New goals default paused unless explicitly enabled. Editing content/budget does not implicitly resume. Deletion removes the goal, not history or files. Goal pause/clear is distinct from interrupting an executing Turn. Other writers stay read-only; no process is closed to force Goal control.
- The queue shown is the **console daemon's in-memory queue**, not native submissions in an external CLI. It does not survive service restarts; idle deployments wait for it to drain. Editing affects text only, preserving attachments/settings. Already dispatched entries cannot be edited/cancelled through the queue; use Turn interrupt.
- Next-turn choices do not reconfigure an active Turn or external CLI. Steering messages guide the current Turn using its existing settings. Custom provider choices are ultimately validated by Codex/provider. Service tiers do not imply universal account access or a price guarantee.
- Context pressure is a best-effort last-turn total divided by reported model capacity, not an exact live context measure. Missing telemetry stays unavailable. Goal budget and account quotas are independent. Compaction may need model access and can fail; errors remain visible. No file rollback is performed.
- Fork UI copies the current completed history into a new conversation. API also accepts `lastTurnId`, but arbitrary historical-turn selection is not exposed in this UI. Archive/restore does not delete user files.
- Account quotas are read-only; detailed financial usage reports/credit purchasing/reset credits are not added. Third-party API providers can legitimately return no OpenAI account quota data. Ordinary-usage denial is not inferred away from percentages/reset dates.
- Inventory panels do not install plugins/skills, change Hook trust, initiate OAuth, modify permissions, or expose config files. Future management workflows require separate authorization and design. Read failures are shown as unavailable, not empty-but-successful.
- Search covers extracted thread titles through native `searchTerm`, not full message-body search. Multi-agent cards provide navigation/status, not autonomous delegation or new agent creation controls.
- No new cloud relay or app-server network listener, no credential/password migration, no public firewall change.

## Validation

Unit tests cover settings conversion, structured results, safe URLs/raster images, sanitized inventory/quotas, context accounting, pagination/forking, Goal normalization, and staged snapshot integrity. Browser tests cover desktop queue mutations, settings/rerouting, mobile Usage/Status, thread actions, structured cards, unsupported/external Goal controls, errors and legacy resend over plain LAN HTTP. `npm run codex:smoke` uses a temporary isolated Codex home and a local mock Responses endpoint, never real account credentials or user threads, to verify native plan settings, queue lifecycle/attachment preservation/draining, rename/fork/archive/restore, inventories, compaction and Goal HTTP/WS lifecycle.

Staged deployment uses source/artifact fingerprints when deploying an explicitly selected uncommitted snapshot. The independent user service waits for six consecutive idle samples, atomically switches the release, updates autostart, validates health/revision, and restores the old configuration if verification fails.

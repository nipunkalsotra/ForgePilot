# Phase 2.1 hardening

18 November 2026, branch `feat/phase-3-autonomous-agent`, starting commit `b9da781`.

## Terminal-state correction

`src/completion.ts` requires explicit `status: done` and an empty `requiredActions` array. Errors, cancellation, unknown/failed/incomplete states, missing fields and unresolved actions fail closed. `Bridge.runTurn` validates terminal state before delivering it to proposal handlers, rejects any events after terminal completion, and requires successful completion before returning. Failure cancels the backend and causes `propose` to invalidate staged patches. Delayed results cannot restore a cancelled proposal. `EventRenderer` uses the same validator. No agent loop or direct model calls were introduced.

Installed SDK 0.185.0 types were inspected: `TurnDoneEventState` is done/error/cancelled; running/paused are nonterminal `TurnState` variants. `TurnStateDone.requiredActions` must be empty. TrueForge 0.185.1 runtime `reportUnexpectedTurnDone` handles error and abandoned/timeout cancellation; its stream drain emits paused updates with keepalive and resumes without a fake successful terminal event. Runtime migration `20261105_000003_turn_done_approval_to_paused` also confirms approval waits must not be treated as successful completion. Live successful and cancelled streams were verified without altering provider configuration.

Regression coverage includes failures before staging, after a real structured tool response is staged, while approval is pending, after model text, missing terminal events, pending actions, and events after completion. All original safety tests remain.

## Dependency audit

Fresh `npm audit --json`: **9 high findings**, one underlying advisory, [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), picomatch ReDoS. `npm audit --omit=dev --json`: **0 findings**.

| Finding | Installed version | Dependency path / exposure |
| --- | --- | --- |
| picomatch | 4.0.7 | typescript-eslint → typescript-estree → tinyglobby → picomatch; development only |
| fdir | 6.5.0 | tinyglobby → fdir → picomatch; propagated development finding |
| tinyglobby | 0.2.17 | typescript-estree → tinyglobby; propagated development finding |
| @typescript-eslint/typescript-estree | 8.73.0 | typescript-eslint → typescript-estree; propagated development finding |
| @typescript-eslint/parser | 8.73.0 | typescript-eslint → parser → typescript-estree; propagated development finding |
| @typescript-eslint/utils | 8.73.0 | typescript-eslint → utils → typescript-estree; propagated development finding |
| @typescript-eslint/type-utils | 8.73.0 | eslint-plugin → type-utils → typescript-estree; propagated development finding |
| @typescript-eslint/eslint-plugin | 8.73.0 | typescript-eslint → eslint-plugin; propagated development finding |
| typescript-eslint | 8.73.0 | direct devDependency; propagated development finding |

`npm view picomatch version` and `npm view picomatch@4 version` reported latest **4.0.7**, which is still in the advisory's `<=4.0.7` range. `npm update picomatch --ignore-scripts` found no compatible fix and changed no dependency files. `npm audit fix --dry-run --ignore-scripts` proposed a dependency tree with typescript-eslint 8.47.0, whose ESLint peer range excludes installed ESLint 10.15.0; npm rejected it with ERESOLVE. No force, legacy-peer override, linter downgrade or fabricated lockfile was used. A compatible fixed picomatch release or upstream dependency remediation is still needed. Remaining exposure is build/lint processing of adversarial glob patterns; the vulnerable packages are not shipped in the production extension bundle. Audit status is **UNRESOLVED**, explicitly accepted as a documented risk rather than a passing security audit.

## Verification gate

| Check | Status | Evidence |
| --- | --- | --- |
| `npm ci` | PASS | 227 packages installed from preserved lockfile; advisory count unchanged |
| `npm run check` | PASS | Strict build/lint, **39 tests passed**, zero failed/skipped; all prior 36 cases retained |
| `npm run test:live` | PASS | Session `01m7qefb2yk95x9fn526gak1x4`; genuine MCP list/read, three text deltas, persisted history, unchanged hashes, connector/process cleanup |
| `npm run test:editing:live` | PASS | Session `01m7qegnejj87xsp8b4qf5t35z`; real approval and streaming/approval-wait cancellation, unchanged workspace |
| `VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension` | PASS | Genuine GUI extension host, native diff, mixed decisions, exact undo, stale/user changes, cancellation and errors; exit 0. Agent fixture clearly distinguished from live evidence |
| Workspace containment / symlink / hardlink / no staging writes | PASS | Original tests plus post-approval path revalidation; no safeguards removed |
| Physical keypress and warning/tree clicks | NOT TESTED | Existing manual instructions remain in Phase 2 report |

No Phase 3 implementation began before this gate and its local hardening commit. Changed files: `src/completion.ts`, `src/bridge.ts`, `src/events.ts`, `tests/completion.test.ts`, `tests/approval.test.ts`, this report. Lockfile and CI enforcement are unchanged.

Remaining concurrency limits are unchanged: `WorkspaceEdit` is not an OS transaction or CAS; a concurrent process can race after validation; one saved-agent client at a time; cancellations cannot retract a dispatched user-approved edit. Provider-outage GUI checks and other operating systems remain NOT TESTED.

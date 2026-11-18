# Phase 3 verification

Date: 18 November 2026. Branch: `feat/phase-3-autonomous-agent`. Starting commit: `b9da781`.

## 1. Executive summary

**Phase 2.1: PASS**, committed locally as `458dd85` (`fix: harden TrueForge terminal states and Phase 2 safety`). Its required gate was finished before Phase 3 implementation began.

**Phase 3 final acceptance: FAIL / INCOMPLETE.** Autonomous mode, bounded retrieval, context inspection, multi-file staging/review, coordinated editor application, creation, rollback and undo are implemented and pass automated checks. **The official live Flask Task B has not passed.** Real runs independently discovered relevant files, but early model proposals failed strict validation and later runs were interrupted by provider overload, connection failures or quotas. No invalid/failed run was converted into an editor change. The isolated Task B checkout remains clean, and no prepared Flask patch was injected.

The latest local suite has **59 passing tests**, zero failures/skips, including all original Phase 1/2 cases. Actual graphical VS Code host tests verify multi-file editor operations with a labelled deterministic agent fixture. These do not substitute for successful real-model Task B evidence. **No Phase 3 commit was created**, because the required acceptance gate did not pass. Nothing was pushed, published or deployed.

## 2. Exact changed files and purpose

This table is the union of hardening and Phase 3 work relative to `b9da781`; hardening is already committed and Phase 3 changes remain uncommitted.

| File | Purpose |
| --- | --- |
| `.github/workflows/check.yml` | Rename the check job; preserve Node 22/24 matrix and strict checks |
| `README.md` | Autonomous usage, references, budgets, configuration, verification and limitations |
| `config/forge-coder.agent.json` | Generic proposal-only agent instructions; no benchmark solution |
| `package.json` | Commands, native review view/actions, keybinding, context/pacing settings, test selection |
| `src/bridge.ts` | Strict completion; autonomous SDK events, exact source/call correlation, genuine approval/question input, deferred wrappers, observations |
| `src/completion.ts` | Fail-closed success predicate and sanitized quota message |
| `src/events.ts` | Shared strict completion validation, preserving read-only event behavior |
| `src/patch.ts` | Preserve inline validator; explain non-empty anchors and copy captured snapshots |
| `src/workspace.ts` | Secure identity/range reads, bounded inventory, new-file path preflight, tracked Git subprocess cleanup |
| `src/context.ts` | Structural/lexical discovery, symbol/reference resolution, ranking, snippets, estimated budget and truncation |
| `src/batch.ts` | Strict bounded modify/create batch, file identity/version/hash/lifecycle/decisions/conflicts; reuse inline primitives |
| `src/coordinator.ts` | Full-batch validation, approved changes, guarded partial-failure restoration and batch undo |
| `src/autonomous.ts` | Native grouped review, diff content providers, context inspector, progress/cancel, VS Code host adapter |
| `src/extension.ts` | Register autonomous commands/views, session modes, shared cancel/stop, normal verification terminal |
| `src/companion.ts` | Pass bounded autonomous configuration through existing IPC lifecycle |
| `src/mcp/child.ts` | Initialize autonomous companion capabilities |
| `src/mcp/server.ts` | Opt-in tools, bounded HTTP handling, cancellable response pacing, workspace cleanup |
| `src/mcp/autonomous.ts` | Inventory/search/symbol/range/context/check/propose MCP tools; no write/shell capability |
| `tests/completion.test.ts` | Explicit-success and unsuccessful/unknown-state regressions |
| `tests/approval.test.ts` | SDK fixtures for failure timing, deferred approval, question isolation, cancellation and source mismatch |
| `tests/context.test.ts` | Discovery beyond 200, scoped queries, references, ranking, budgets, ranges, long lines and Git cleanup |
| `tests/batch.test.ts` | Mixed review, lifecycle, conflicts, creation, undo and simulated partial failures |
| `tests/mcp.test.ts` | Genuine MCP transport tests for new capabilities, no-write checking and response pacing |
| `tests/batch-host.ts` | Actual VS Code multi-file native diff/application/creation/undo tests using a labelled proposal fixture |
| `tests/autonomous-host.ts` | Real Task B driver with a filename-free instruction, approval/review, command assertions and evidence capture |
| `tests/extension-host.ts` | Preserve original host checks; add autonomous and batch checks |
| `docs/phase-2-hardening.md` | Stage 1 gate, SDK/runtime inspection and dependency investigation |
| `docs/architecture.md` | Combined inline/autonomous architecture and actual guarantees |
| `docs/phase-3-verification.md` | This report |

`package-lock.json` is unchanged. No dependency was manually replaced or forced into an incompatible peer range. Generated bundles, isolated checkouts/environments and `artifacts/` evidence are ignored.

## 3. Phase 2.1 results

The installed SDK confirms terminal variants `done`, `error`, `cancelled`, with paused/running nonterminal states. Success now requires explicit `done` and an empty required-action list. Unknown/failed/incomplete states, malformed terminal data, pending actions, missing completion and events after completion fail closed. A staged proposal is cancelled when its turn fails. Broader Phase 3 review also added rejection of length-limited, filtered/tool-requesting or explicitly refused final output, with a post-staging SDK regression; these additional guards are currently uncommitted with Phase 3. Backend cancellation, owned connector removal and companion shutdown remain intact.

Gate commands passed: `npm ci`, `npm run check` (**39 tests at the hardening commit**), `npm run test:live`, `npm run test:editing:live`, and the genuine graphical host test. Live sessions: `01m7qefb2yk95x9fn526gak1x4` (read-only) and `01m7qegnejj87xsp8b4qf5t35z` (editing approval/cancellation). The full dependency investigation is in the hardening report.

At Stage 1, npm reported nine propagated development findings from picomatch advisory `GHSA-fc5q-39xc-vjpf`. The newest published compatible version was still affected; the suggested dry-run rollback conflicted with ESLint's peer range. No force/legacy-peer workaround was used. A later **fresh full `npm audit --json` reported zero findings**, as did the final clean install, with the same lockfile and picomatch 4.0.7. This is an observed change in audit results, **not a claim that ForgePilot patched picomatch**. The historical Stage 1 report retains its actual findings.

## 4. Autonomous architecture

`ForgePilot: Autonomous Agent` accepts one request without an editor selection or filenames. The saved TrueForge agent receives generic tool/protocol instructions, drives discovery and planning, checks its draft and requests staging permission. `Bridge` consumes SDK streaming and sends actual SDK user events; it does not implement a separate model/tool agent loop.

The original read-only and inline modes remain separate. Read-only sessions expose exactly three tools; inline sessions add `propose_patch`. Autonomous sessions expose the three legacy tools plus seven bounded discovery/context/validation/proposal tools. The companion still receives a random token/root over IPC, binds loopback only and closes on parent IPC loss. Git metadata subprocesses are bounded, tracked and terminated on cleanup.

## 5. Retrieval implementation

Inventory uses fixed-argument `git ls-files --cached --others --exclude-standard -z` with fsmonitor disabled, or a bounded filesystem fallback. It handles tracked and permitted untracked sources, including files beyond the first 200. Limits: 10,000 files, 30,000 fallback entries, depth 20, bounded Git output/timeout and cooperative wall-time checks. Every result follows the original deny policy; every content read revalidates paths/links and the actual descriptor. Tracking never authorizes secrets, hidden paths, symlinks or hardlinks.

`discover_files` supplies literal path filtering and pagination. `search_code` performs case-insensitive literal keyword/identifier/reference search with file/directory scopes and bounded matches. `lookup_symbol` finds Python/JS/TS declaration locations heuristically. `read_range` returns at most 200 lines, identity and the full-file hash from UTF-8 files up to 1 MiB. Legacy reads and editable files retain their 64 KiB bound.

`context_query` ranks path matches, lexical evidence near useful lines, declarations, import relationships and implementation/test/documentation counterparts. It returns actual candidate reasons and bounded snippets. Explicit `@file:path`, `@symbol:name`, parenthesized forms and shorthand references are resolved inside the same authorized boundary. Missing symbols, forbidden references and oversized input fail; unsuitable long-line snippets are omitted with truncation rather than disabling validation.

## 6. Context-budget methodology

Default: **12,000 estimated tokens**, configurable 2,000–32,000. Estimate: `ceil(UTF-8 bytes / 3)`, including serialized package metadata, with a declared instruction/output reserve. Candidate metadata/snippets are reduced until the package fits; selected/omitted/truncated counts are returned. A separate 20,000-character transport cap accommodates the installed TrueForge 24,000-character tool-result limit.

The budget applies to **each assembled context package**, not to the cumulative provider conversation. Additional workspace tool response byte estimates are shown separately in the inspector; provider instructions, reasoning/output and cumulative repeated-input billing are not mislabeled as exact context-package counts. TrueForge still owns its conversation context and configured compaction. This report claims actual deferred-tool use, not unobserved compaction execution.

## 7. Multi-file staging, review and application

One batch contains at most 12 unique paths and 90,000 serialized bytes. Modify/create variants remain strict. A flat advertised schema improves provider compatibility; both MCP input refinement and the domain parser enforce the same variant rules. Existing-file modifications reuse `PatchStore`, exact original hashes, unique non-empty anchors, overlap rejection and `diffHunks`. Creation requires an existing safe parent and absent target; it never overwrites a file. Each file records identity or creation state, baseline text/hash/version, individual hunk decisions, status and conflict state.

`check_batch` is a read-only draft validator. It returns feedback inside TrueForge's loop and never creates an extension-reviewable proposal, grants approval or writes files. `propose_batch` requires genuine SDK staging permission. The extension only completes the staged batch after explicit successful terminal confirmation.

Native diff tabs and Explorer's grouped **ForgePilot Agent Changes** tree support independent file/hunk decisions, remaining-hunk actions and keyboard Quick Picks. Every hunk needs a decision. The coordinator reconstructs accepted content only, revalidates **all** targets and editor versions, then dispatches one `WorkspaceEdit`. New files use reviewed create operations. Edits remain buffers until normal Save.

False/throwing/partial application is reported. Only recognizable applied portions with unchanged document and disk state are restored. Unknown/subsequently changed portions are preserved and flagged for inspection. Batch undo restores preceding content and reviewed creations, refusing stale/externally changed targets. The last successful batch's undo record survives a subsequent failed generation. Undo and rollback also verify that reviewed creations were actually removed, even if the editor reports success or drops its document reference. These are guarded editor operations; **no filesystem transaction, filesystem lock or public version CAS is claimed**.

## 8. Approval, cancellation and context-engineering depth

Actual SDK `sessions.createTurnEvents` submits `user.tool_approval`, or a supported `user.tool_response` for the harness's native question tool. Tool identity is correlated to the exact source event/call ID. Installed TrueForge can persist source messages without sending them over SSE; the bridge resolves exact persisted references. Deferred `call_tool` wrappers must identify the owned connector and allowed underlying tool. Answering an agent question cannot approve staging or hunks.

Cancellation aborts the client stream, requests `sessions.cancel`, invalidates the store/request generation and ignores delayed results/answers. If backend cancellation cannot be acknowledged, companion termination revokes workspace access. Failed terminal completion cannot reactivate a proposal. User denial remains terminal; it is not treated as an invitation to bypass approval.

Common context/read/search/check/proposal schemas are eager. Inventory, symbol and legacy schemas are deferred. Genuine traces include `list_tools`, `get_tool_info` and wrapper calls to repository tools. That is real use of installed TrueForge deferred loading, not only an enabled property. Optional `forgepilot.autonomousToolIntervalMs` (default 0, at most 10,000 ms) serializes/cancels MCP result delivery to reduce provider request bursts. It does not retry or call models; the live driver uses 10,000 ms.

## 9. Automated and host verification

| Check | Status | Result |
| --- | --- | --- |
| Clean `npm ci` | PASS | Reproducible install; latest audit result zero findings |
| `npm run check` | PASS | **59 passed**, zero failures/skips; strict TypeScript and ESLint unchanged |
| Phase 1/2 original tests | PASS | All 36 pre-hardening tests remain; all original 17 Phase 1 cases retained |
| SDK contract fixtures | PASS | Named sessions, deferred correlation, explicit allow/deny, question isolation, terminal failures and delayed cancellation |
| Actual MCP HTTP | PASS | Discovery/search/context/check/proposal tools, strict no-write behavior, path policy and pacing |
| `npm run test:live` (post-Phase-3 rerun) | PASS | Session `01m7qwjaej3pkr5dpp5rb1sgch`; four deltas, real MCP/history, unchanged hashes and cleanup |
| `npm run test:editing:live` (post-Phase-3 rerun) | PASS | Session `01m7qwre8a04r0nwmskmcjx3zj`; genuine approval, mixed hunks, streaming/waiting cancellation |
| Fresh live Flask Task A host regression | PASS | Session `01m7qwx0e63c48s1ejc0e8sagm`; two native hunks, exact undo, required false values and preserved behavior |
| Pinned Flask Task A helper regressions | PASS | `pytest tests/test_helpers.py -q`: **35 passed**, exit 0, using the isolated checkout |
| Actual VS Code host | PASS | Native per-file diffs, mixed file/hunk decisions, coordinated edit, reviewed creation, undo after failed subsequent generation and user-change protection |
| Partial application / partial undo | PASS | Simulated failures and falsely reported successful deletions are asserted; no atomic filesystem claim |
| Discovery >200, Git/untracked/scoped search | PASS | Late target found; links/hidden paths excluded |
| Reference/ranking/budget/truncation | PASS | Assertions cover explicit references, omissions, large files/lines and measured estimates |
| Companion/Git cleanup | PASS | Explicit stop/IPC loss and an actual in-flight metadata subprocess termination |
| Physical keyboard/tree/warning-button clicks | NOT TESTED | Actual host APIs/commands used; human interactions remain manual |
| macOS/Windows and Node 22/24 CI execution | NOT TESTED | Linux desktop/Node 26 local run; matrix configuration preserved |

Deterministic proposal fixtures are explicitly labelled in their source and host output. They are not evidence that the real model completed Task B.

## 10. Official Flask Task B outcome

**FAIL — no complete approved batch was delivered by a successful live turn.** No Flask source was manually modified, no prepared solution was injected, and no failed proposal was applied. Post-change CLI tests, `config` help visibility and masked JSON output are consequently **NOT TESTED**. The unmodified baseline `pytest tests/test_cli.py -q` did run: **58 passed**, exit 0; this is explicitly a baseline, not agent-success evidence.

The isolated checkout is `/tmp/forgepilot-flask-taskb`, tag 3.1.3, exact commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Each of the 17 live Task B attempts asserted clean `git status --porcelain` before starting. It remains clean after the failed runs; the final Git diff is empty.

The driver uses the exact official Task B wording in `TASK_B` in `tests/autonomous-host.ts`, followed by these feature clarifications: case-insensitive sensitive-key detection, parseable JSON, no sensitive values in errors/logs, implementation/tests/documentation together, and serialization of existing defaults. **No source/test/documentation filenames are in the user request.** Protocol examples contain no Flask implementation. Expected paths/assertions exist only in verification code and are not injected into the agent request.

The driver is ready to assert every file's actual native diff content, unchanged originals before permission, individual hunk acceptance, accepted editor buffers, saves, CLI test output/exit codes, help registration and parsed JSON from a small app covering all four sensitive categories. It verifies ordinary values and rejects marker leakage in stdout/stderr. Those post-application assertions have not yet been reached in a successful live run.

## 11. Genuine sessions and retrieval evidence

Selected real sessions, retained in local TrueForge:

| Session | Actual outcome |
| --- | --- |
| `01m7qefb2yk95x9fn526gak1x4` | Stage 1 read-only live PASS |
| `01m7qegnejj87xsp8b4qf5t35z` | Stage 1 editing approval/cancellation live PASS |
| `01m7qfqmszaa7xbr8hm8px22xx` | Real automatic discovery/context; duplicate-path proposal rejected before application |
| `01m7qt1z2rq8qv2mj5a82pw656` | Real automatic discovery/context; incorrect source anchor rejected |
| `01m7qtf311sxsvabprm2wrxzjh` | Authorized Pro alternative returned free-plan quota limit zero |
| `01m7qtxg23e0fnce37qeksgmh0` | Authorized Flash Lite alternative made tool calls, then provider overload |
| `01m7qv0eyhzx6nwhjfvf9z38gt` | Authorized alternative reached input-token-per-minute quota |
| `01m7qw1w1awv00b8f23h3fe606` | Final original-model attempt: **25 real tool calls**, partial draft validation, then provider high demand; **FAIL** |

The final attempt retrieved **216 candidates**, with the CLI source, CLI tests and CLI documentation selected independently. Its package estimated **6,554 tokens out of 12,000**; paths included `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, `tests/test_basic.py` and `CHANGES.rst`. An earlier real package scanned **1,541,807 bytes**, estimated **6,659 tokens**, reserved **1,020**, and selected the same three required roles plus related sources. Exact reasons/snippets/candidates are in `artifacts/phase3-taskb-attempt4.json` and session history; they were not invented by the report.

Final failed-turn metrics, exactly as supplied by TrueForge: input **439,656**, output **5,402**, total **445,058**, cached input **269,461**, reasoning **2,294**. These are cumulative turn usage, distinct from the context-package estimate. Provider cost was not supplied; no price is invented.

Models used through TrueForge: original `google-gemini/gemini-3-1-flash-lite`; after explicit user authorization, configured `gemini-3-5-flash`, `gemini-3-1-pro-preview`, `gemini-flash-latest`, and `gemini-3-5-flash-lite` alternatives were tried. They encountered connection/high-demand/quota failures. The saved agent is restored to the **original model**. Only its generic instructions/model selection were changed; provider credentials/endpoints were not changed. An idle local-service restart preserved saved data/configuration. Credential-free HTTPS host diagnostics made no inference calls.

Final read-only SDK cleanup inspection confirmed the original model, an empty saved-agent MCP attachment list, and zero remaining `forgepilot-*` registrations.

Ignored evidence files `artifacts/phase3-taskb.json` and `artifacts/phase3-taskb-attempt*.json` preserve failures as well as tool history. The report does not recast failed runs as successes. No Phase 3 session is claimed to contain a successfully applied Flask solution.

## 12. Security and concurrency limits

- One active client per saved agent; manifest updates have no conditional-write API. Closed local access can leave stale registry metadata after a hard kill; owned cleanup is attempted and failures are reported.
- Existing-file edits retain the 64 KiB before/after limit and 4,000,000-cell diff bound; larger files can be read in ranges but are not editable through this phase.
- Text edits are bounded, not unrestricted shell/write capabilities. New parents must exist; empty new files/deletes/renames are not autonomous proposal operations. Undo can remove an explicitly approved creation.
- Apply/rollback/undo can race after their final asynchronous validation. Unknown or user-modified states are preserved and reported. Cancellation cannot retract a user-approved edit already dispatched.
- Undo/proposals are in-memory and require the expected open documents and disk state. They do not survive restart.
- Symbol/import analysis is heuristic; inventories/searches are bounded and report truncation. Budget estimates are not exact provider token counts or a global cumulative conversation cap.
- Filename policy cannot classify credentials embedded in otherwise ordinary permitted source. Model credentials are not inherited by the companion or logged.
- Shared provider quotas and high demand remain external blockers. Pacing reduces bursts but cannot guarantee capacity or recover a failed provider turn.

## 13. Manual GUI checks pending

**NOT TESTED:** physical Ctrl+Alt+A invocation, typing the instruction, clicking native staging permission, tree check/cross buttons, Quick Pick choices and a recorded judge walkthrough. To check: open/trust a fresh pinned checkout, invoke Autonomous Agent, enter the Task B instruction without filenames, inspect Output/context evidence, allow staging, inspect each file diff, mix decisions, apply/save, undo, and retry with an external/user conflict and cancellation during streaming/approval/staging. Confirm accepted-only contents and that stale/failed/cancelled proposals cannot apply.

These human actions remain separate from the actual automated graphical host tests.

## 14. Reproduce and current readiness

```sh
npm ci
npm run check
npm run test:live
npm run test:editing:live
VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension

git clone --branch 3.1.3 --depth 1 https://github.com/pallets/flask.git /tmp/flask-task-b-fresh
uv venv /tmp/flask-task-b-venv
uv pip install --python /tmp/flask-task-b-venv/bin/python -e '/tmp/flask-task-b-fresh[async,dotenv]' 'pytest<9'
FORGEPILOT_PHASE3_FLASK=1 FORGEPILOT_FLASK_ROOT=/tmp/flask-task-b-fresh \
  FORGEPILOT_FLASK_PYTHON=/tmp/flask-task-b-venv/bin/python \
  VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension
```

Use the actual VS Code executable on the target machine. Run live checks sequentially against the saved agent and a working configured provider. The driver uses a disposable profile, 600-second deadline and 10,000 ms tool interval. A new clean checkout is required for repeat acceptance runs. Existing saved agents should use the generic proposal-only instructions in the checked-in definition; setup otherwise preserves existing configuration.

**Competition readiness: FAIL at the Phase 3 gate.** Local implementation tests pass, but the decisive successful real-agent Task B, post-change CLI tests and masked JSON are missing. Do not record/publish a success demo or create the requested Phase 3 acceptance commit on the present evidence.

| Final acceptance criterion | Status | Scope of evidence |
| --- | --- | --- |
| Phase 2 regressions and unsuccessful terminal handling | PASS | Original cases, strict failure fixtures and real live regressions |
| Context retrieval, explicit budgeting and inspector | PASS | Deterministic assertions plus real autonomous retrieval traces |
| Autonomous command and streamed activity | PASS | Actual extension host and real TrueForge executions |
| Relevant files discovered without filenames | PASS | Real Task B instruction and independently selected implementation/tests/docs |
| Valid multi-file proposals through a successful TrueForge turn | FAIL | No complete Task B batch survived a successful terminal event |
| Independent multi-file hunk review and approved application | PASS | Actual VS Code APIs with a labelled deterministic proposal fixture; live Task B application NOT TESTED |
| Cancellation, conflicts and undo | PASS | SDK/MCP assertions, live inline cancellation and actual editor operations |
| Official Task B implemented by the real agent | FAIL | No approved complete solution; clean checkout preserved |
| Post-change Flask CLI tests/help/masked JSON | NOT TESTED | Baseline CLI tests passed, but cannot establish the new feature |
| Genuine tool/session evidence | PASS | Local TrueForge history and ignored JSON evidence preserve successes and failures |
| Complete verification report | PASS | This report records the missing acceptance evidence explicitly |

## 15. Remaining work and Git delivery

First finish the existing Phase 3 gate with an available configured model, review/apply the real three-file batch and capture passing post-change tests/help/JSON. Re-run the live regression checks and update this report with genuine successful evidence before making a Phase 3 commit.

Only after that should Phase 4/final-submission work cover official Task C resilience, any needed retry/fallback integration inside TrueForge, real compaction evidence if claimed, platform coverage, human GUI walkthrough, and the submission video/write-up. None of that later-phase implementation was started here.

Local hardening commit: `458dd85`. Phase 3 remains uncommitted on the requested branch because its gate failed. No push, publish or deployment occurred.

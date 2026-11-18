# Phase 2 verification

Date: 18 November 2026. Scope: inline editing, proposal staging, native hunk review, approval, safe buffer application, undo and cancellation. No Phase 3 work, push or publication.

**Result: automated acceptance and live Task A passed on Linux. Manual keyboard/button acceptance remains NOT TESTED.** An actual graphical VS Code Extension Development Host ran these checks; it was not replaced by a VS Code mock. Automated test code supplied explicit approval decisions. No claim is made that a person clicked the warning, toolbar or hunk icons.

## Architecture and safety boundaries

The original `Bridge`, saved `forge-coder` agent, SDK streaming, bounded `Workspace`, authenticated companion MCP HTTP server and teardown remain in use. Read-only sessions still discover exactly three tools. Inline sessions opt into a fourth tool, `propose_patch`, and attach `requireApprovalForTools: ['propose_patch']`. No filesystem write, shell, hunk approval or commit tool is exposed to the agent. Sandbox, other connectors, skills, dynamic subagents, web search, memory and generative UI remain rejected by the agent policy. All model and agent execution stays inside TrueForge.

The extension captures the saved local document, version, selected offsets and relative path before prompting. Unsaved input, empty selection, closed editor, virtual editor and out-of-workspace targets fail safely. The prompt includes the selected code, target metadata, SHA-256 of the original document and developer instruction. There is no provider SDK, independent agent iteration, task-specific code substitution or Flask knowledge in extension code.

The structured MCP input is `{ path, baseHash, edits: [{ oldText, newText }] }`. The strict Zod schema rejects extra fields, missing values, invalid hashes, empty/oversized edits and excess edit counts. JSON is bounded to 256 KiB. Replacements must match uniquely within the selection; overlaps and changes outside the selection fail. Existing Phase 1 path, symlink, hardlink, regular-file, UTF-8 and size restrictions are reused, including descriptor containment on Linux. The proposal tool validates against the original file and returns `{ kind: 'forgepilot.patch', patch }`. It never writes files.

The installed SDK was inspected before implementation: `ToolApprovalRequiredEvent.toolCalls` contains references with `id` and `sourceEventId`; `UserToolApprovalInputEvent` contains `threadId`, `toolCallId` and an `allow`/`deny` decision. The correct submission method is **`sessions.createTurnEvents(sessionId, turnId, { events })`**, not a new model turn. Cancel uses **`sessions.cancel(sessionId, {}, requestOptions)`**. TrueForge 0.185.1 sometimes persists the source `model.message` without emitting it on SSE. ForgePilot resolves that exact source event from SDK history, validates its tool identity and arguments, then asks the developer. A missing/mismatched source fails closed. Rejection submits a real SDK deny decision and cancels. No sticky allow-session approval is installed.

After SDK approval, the response from that exact tool call can stage one proposal. Proposals record random ID, relative target, original document/version/hash, disk hash, validated edits, proposed content, individual hunk IDs/offsets, review decisions, tool approval and lifecycle status. Staging is memory-only. Bounded line LCS produces independently reviewable contiguous changed regions, preserving CRLF and EOF. There is no whole-file approval masquerading as per-hunk review.

Native `vscode.diff` displays immutable virtual original and proposed documents. Explorer's **ForgePilot Patch Review** tree shows line numbers and pending/accepted/rejected decisions, individual check/cross actions and commands for all-hunk actions. The keyboard review command uses native Quick Picks. Rejecting a hunk removes it from the preview. Every hunk must be reviewed before Apply. The result is reconstructed from **accepted hunks only** against the original offsets.

Immediately before dispatch, the extension rechecks disk content through the secure workspace reader, document version/content and closed state. It applies one text-only `WorkspaceEdit`, checks its boolean result and resulting buffer, and records the exact preceding content for custom Undo. Failed application is terminal for the proposal. Undo requires the same open document/version and exact post-edit content, and rejects external disk changes; a normal save of the accepted result is permitted. Applied edits remain in the editor buffer until normal Save. Undo likewise restores the buffer and may need Save.

Cancellation invalidates the request generation and staged proposal, aborts the client stream, requests genuine SDK cancellation, checks the abort signal around asynchronous event handling, and ignores delayed approval/tool results. Rejected/cancelled proposals cannot transition back to review or apply. A pending warning may remain visible until dismissed, but its delayed answer cannot approve a cancelled request.

## Commands executed and results

| Command/check | Result | Evidence |
| --- | --- | --- |
| `npm ci` | PASS | Lockfile installation succeeded. npm reported 9 high development dependency findings; see limitations. |
| `npm run check` | PASS | Strict TypeScript build, ESLint with zero warnings, **36 tests passed**, none failed/skipped. Includes all original 17 Phase 1 tests. |
| `npm run test:live` | PASS | Genuine named session, four streamed text deltas, real MCP list/read, persisted tool history, equal workspace hashes and teardown. |
| `node --import tsx scripts/verify-editing-live.ts` / `npm run test:editing:live` | PASS | Genuine approval-required → user-approval → proposal response; two hunks, mixed review, unchanged disk; real cancellation while streaming and waiting for approval, plus invalidation after staging. |
| `VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension` | PASS | Actual graphical host, exit 0. Deterministic agent fixture, actual selection/diff/WorkspaceEdit APIs, mixed decisions, accept/reject all, exact undo, subsequent user edits, stale document, cancellation, model failure and closed editor. This fixture is not model evidence. |
| `FORGEPILOT_EXTENSION_LIVE=1 VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension` | PASS | Original full chain through extension start/ask/stop commands, actual MCP read marker and registry cleanup. |
| Flask host command below | PASS | Fresh pinned checkout, exact instruction, genuine saved-agent tool approval and response, native diff content assertions, per-hunk acceptance, apply, exact undo, re-proposal/reapply/save and actual Python import/behavior. Exit 0. |
| `PYTHONPATH=/tmp/forgepilot-flask-final/src /tmp/forgepilot-flask-venv/bin/python -m pytest /tmp/forgepilot-flask-final/tests/test_helpers.py -q` | PASS | **35 upstream Flask helper tests passed**. |
| Official `FLASK_DEBUG=off ... print(get_debug_flag())` | PASS | Printed **False** using the isolated checkout. |
| `git diff --check` | PASS | No whitespace errors in implementation changes. |
| `npm audit --omit=dev --json` | PASS | Zero reported production dependency vulnerabilities; full audit findings are limited to development tooling. |

The restricted command sandbox could not run local socket integration tests; they passed with permitted local access. The first live run could not reach the stopped server. The installed TrueForge 0.185.1 service was then started with existing saved data and `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`. Two early Phase 2 live attempts exposed the persisted-message ordering and unwrapped MCP text format; both failed safely and were corrected before the successful runs. The initially installed pytest 9.2.0 was incompatible with Flask's existing `monkeypatch.notset` fixture; the isolated environment was changed to pytest 8.4.2 and Flask's async test dependency, after which all 35 helper tests passed. Flask source/tests were not modified to work around this.

## Mandatory acceptance matrix

| Criterion | Status | Verification |
| --- | --- | --- |
| 1. Selection capture and active-file metadata | PASS | `patch.test.ts`, genuine host selection of fixture and Flask function. |
| 2. Valid patch generation/parsing | PASS | Strict schema tests, real proposal MCP HTTP test and live agent output. |
| 3. Malformed patches rejected | PASS | Missing/extra fields, bad JSON, invalid hashes, ambiguous/overlapping edits, model errors. |
| 4. Staging without disk mutation | PASS | Real filesystem/MCP tests; live hash equality; host asserts disk and buffer unchanged before approval. |
| 5. Correct independent hunks | PASS | Add/delete/replace, CRLF/EOF tests; two-hunk live fixture and Flask diff. |
| 6. Accept all | PASS | Reconstruction tests and actual host apply. |
| 7. Reject all | PASS | Terminal rejection; subsequent review/apply denied; actual host check. |
| 8. Mixed acceptance/rejection | PASS | Core and live reconstruction; actual host buffer contains only accepted first change. |
| 9. Undo restores preceding content | PASS | Actual `WorkspaceEdit` undo action, including live Flask original hash/content; refuses subsequent user changes. |
| 10. Stale document rejection | PASS | Content/version tests and actual user buffer modification in host. |
| 11. External-file conflicts | PASS | Secure disk revalidation before apply; original Phase 1 boundary tests retained. |
| 12. Traversal and symlink protection | PASS | Stage and post-approval symlink replacement tests; original descriptor/race/hardlink tests. |
| 13. Cancellation before approval | PASS | SDK-contract, host and real TrueForge waiting-approval cancellation. |
| 14. Delayed results after cancellation | PASS | Late staging, late human answer and late tool response tests; live late approval answer. |
| 15. Model errors/invalid output | PASS | Event, schema and SDK-contract failures; host confirms original content preserved. |
| 16. All 17 Phase 1 tests preserved | PASS | Original test cases still pass within the 36-test suite; SDK and extension live regressions also pass. |
| Native original/proposed diff content | PASS | Real `TabInputTextDiff` and both virtual document contents asserted in live Flask host. |
| Genuine TrueForge approval distinct from hunk review | PASS | Persisted real approval events; staged hunks remain pending after SDK approval. |
| Agent cannot write or approve own edits | PASS | No write/apply/approve capability in MCP; wrong tool identity fails closed; no hunk decisions derive from agent messages. |
| Loading, streaming, errors, cancellation states | PASS | Native progress, real SSE and error handling exercised; cancellation checks above. |
| Apply failure handling | PASS | Boolean/content check and terminal failure state; failed-proposal retry unit test. A naturally occurring native `applyEdit=false` failure was not induced. |
| Physical keybinding invocation and typed instruction | NOT TESTED | Registered keybindings/commands and programmatic selection/edit are verified; see manual steps. |
| Human warning-button / tree-icon / Quick Pick clicks | NOT TESTED | Native components implemented, automated explicit approval callbacks/commands used in host tests. |
| Genuine provider outage/invalid credential GUI run | NOT TESTED | SDK-contract/model-error and unavailable-server handling covered; provider configuration was not deliberately broken. Official Task C is outside this phase. |

## Live evidence

All sessions bind the existing saved **`forge-coder`**, agent ID `01m7mk1a79ev6z2wzfq1kg094c`, and model **`google-gemini/gemini-3-1-flash-lite`**, with provider configuration held by local TrueForge. No model credential was added to the repository. TrueForge did not supply a cost figure; no cost is invented.

| Run | Genuine session ID |
| --- | --- |
| Phase 1 SDK regression | `01m7qc94wg946y133x8nr4q96n` |
| Proposal approval/mixed hunk integration | `01m7qcp9qhw93nsx48xbjyd0w8` |
| Final proposal plus streaming/approval cancellation | `01m7qd4edcs9cthhnsyk7gqw9k` |
| Final fresh Flask Task A, including undo and re-proposal | `01m7qd9h1hgj2bajk67j1r3x7a` |
| Phase 1 extension-command live regression | `01m7qda0wtb91q690svah5karx` |

In the final proposal run, real `tool.approval_required` event `01m7qd4j5n1efsrxssjczs2dk8` precedes `user.tool_approval` `01m7qd4j70spx7n829c1b29kza` and tool response `01m7qd4j8423vcv9drm3dna18h`, call `call_5205220575086999892`. The fixture hash remained `ba12d11e98d3f364012e88551db5a2ffc4c4b6fa65c6d31d26e58677a8ce50aa`. Real SDK cancellation was acknowledged in both subsequent interrupted turns. The driver checks that a delayed allow answer creates no proposal and the file remains unchanged. A final independent SDK history audit confirmed **two persisted cancelled turns**, exactly one `allow` decision in that session, **zero remaining ForgePilot connectors**, and an empty saved-agent connector attachment list.

Machine-readable evidence is kept locally in ignored `artifacts/live-verification.json`, `artifacts/phase2-live.json` and `artifacts/flask-phase2.json`. Session history remains in the local TrueForge service; temporary connectors were detached/deleted and companion processes stopped. The local TrueForge server remains running for inspection.

## Official Flask Task A

Source: [official competition PDF](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf), fixed tasks table. The test driver supplies the exact instruction from that table; test data lives only in `tests/editing-host.ts`. There are no Flask special cases in `src/`.

The fresh checkout was `/tmp/forgepilot-flask-final`, from release tag 3.1.3, full commit **`22d924701a6ae2e4cd01e9a15bbaf3946094af65`**. It was cloned from the clean Git commit of the isolated upstream download, and `git status --porcelain` was asserted empty before the test. Only `src/flask/helpers.py` was changed, by ForgePilot's approved `WorkspaceEdit` and normal Save. The final diff has two hunks: docstring and return expression (including one blank-line deletion inside the selected region). Its case-insensitive false set includes the two requested additional strings and preserves existing named false strings. The generated docstring lists the five named false strings and retains the default-false description.

Original full-document SHA-256: `ac96607bbfc9dbcf09d5442fe7e90d7f8a046b0df7d8f3fc3535b44112016d71`.

Final approved full-document SHA-256: `d72e09ed68f2716eb0769c7e2399ff331e1bb4f606f5ae2470027b8edf9b5f95`.

| Inputs | Result |
| --- | --- |
| `off`, `OFF`, `n`, `N` | False — PASS |
| Empty, `0`, `false`, `FALSE`, `FaLsE`, `no`, `NO`, unset | False — PASS |
| `1`, `true`, `yes`, `on`, `random` | True — PASS |
| Original Flask helper suite | 35 passed — PASS |

The host asserted one native diff tab, exact original/proposed virtual contents, pending hunk decisions before review, per-hunk accepts, exact undo content, and genuine approval history. The final file is intentionally left in the isolated temporary checkout for inspection. No manual Flask source edit was used.

Reproduce against a **fresh** checkout, with the installed TrueForge server running and one live verification at a time:

```sh
npm ci
npm run check
npm run test:live
npm run test:editing:live
VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension
FORGEPILOT_EXTENSION_LIVE=1 VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension

git clone --branch 3.1.3 --depth 1 https://github.com/pallets/flask.git /tmp/flask-task-a-fresh
uv venv /tmp/flask-task-a-venv
uv pip install --python /tmp/flask-task-a-venv/bin/python -e '/tmp/flask-task-a-fresh[async]' 'pytest<9'
FORGEPILOT_PHASE2_FLASK=1 FORGEPILOT_FLASK_ROOT=/tmp/flask-task-a-fresh \
  FORGEPILOT_FLASK_PYTHON=/tmp/flask-task-a-venv/bin/python \
  VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension
PYTHONPATH=/tmp/flask-task-a-fresh/src /tmp/flask-task-a-venv/bin/python -m pytest /tmp/flask-task-a-fresh/tests/test_helpers.py -q
```

## Manual GUI checks still required

1. Launch the development extension with F5, open/trust another fresh pinned Flask checkout, open `src/flask/helpers.py`, save and select `get_debug_flag`.
2. Press Ctrl+Alt+I (Cmd+Alt+I on macOS), type the exact Task A instruction from the PDF, and observe native loading and streaming in ForgePilot Output.
3. Click Allow Staging. Confirm the original editor/file remains unchanged and the native diff and Patch Review tree appear.
4. Select each hunk, inspect its diff, accept one and reject another. Confirm row decisions and updated preview. Apply Accepted Hunks and inspect that only the accepted change appears. Undo Last Accepted Edit and verify exact restoration.
5. Generate again, accept all relevant hunks, apply and save. Run the four required environment values and the existing behavior checks above.
6. Repeat and cancel while streaming, during the staging warning and after staging. Dismiss any late warning, attempt Apply and verify it cannot modify the original. Edit the original while a proposal is pending and confirm Apply reports stale content. Edit after application and confirm custom Undo refuses to overwrite that edit.

These human interactions are **NOT TESTED** in this report, even though genuine host APIs and real model paths passed under automated control.

## Limitations

- `WorkspaceEdit` is asynchronous and has no public compare-and-swap version option here. Checks happen immediately before dispatch; another extension or OS process can race after the last check. This is not an OS transaction, durable disk transaction, filesystem lock, or absolute defense against a concurrent hostile process. Cancellation after the user has dispatched Apply cannot retract the edit already in flight. Accepted content stays in the buffer until Save.
- Exactly one selected file/proposal and one saved agent instance at a time. Reject-all/cancel are terminal. Undo stores only the latest accepted edit in memory, requires the same open document/version, and does not survive extension restart. Proposals and virtual previews are not persisted.
- Bounded UTF-8 files, 64 KiB before/after, at most 64 replacements and 4,000,000 LCS cells. Dirty files must first be saved. BOM/encoding differences fail the original/disk comparison safely. No arbitrary creates/deletes or multi-file edit mode.
- Native text diff hunks can be visually grouped by VS Code's display algorithm; authoritative decision units are the changed regions in the Patch Review tree. Adjacent changed lines form one hunk. The proposed side is read-only and reflects pending/accepted changes until rejected.
- macOS/Windows, alternative providers, authenticated OIDC, and Node 22/24 standalone runtime matrices were NOT TESTED in this phase. Installed Linux desktop host and Node 26 development runtime were tested.
- `npm ci`/`npm audit` reported nine inherited high **development** dependency findings rooted in picomatch ReDoS (`GHSA-fc5q-39xc-vjpf`, propagated through tinyglobby/typescript-eslint). They do not add a proposal/apply tool capability, but remain unresolved dependency maintenance work. No production-provider configuration was changed to work around them.
- Manual on-screen judging/video, keypresses and warning/tree/Quick Pick clicks remain NOT TESTED. This report does not claim full manual competition acceptance or the Phase 3/multi-file capabilities.

## Exact files changed

Modified existing files (10):

```text
README.md
package.json
scripts/verify-extension.ts
src/bridge.ts
src/companion.ts
src/extension.ts
src/mcp/child.ts
src/mcp/server.ts
tests/extension-host.ts
tests/mcp.test.ts
```

Added files (7):

```text
docs/phase-2-verification.md
scripts/verify-editing-live.ts
src/editing.ts
src/patch.ts
tests/approval.test.ts
tests/editing-host.ts
tests/patch.test.ts
```

The lockfile, agent definition, Phase 1 verification report and original 17 test cases are preserved. Generated bundles/evidence and the isolated Flask checkout/environment are not repository source changes.

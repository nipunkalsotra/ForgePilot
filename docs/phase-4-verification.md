# Phase 4 verification — model resilience and official Task C

## 1. Executive summary

**Phase 4: PASS for the automated and genuine live acceptance gates described below.** Verified 19 November 2026 on Linux, local TrueForge **0.185.1**, SDK **0.185.0**, VS Code **1.117.0**. All **79 tests** pass, including all original 65. Actual development and installed-VSIX hosts pass all 25 command registrations, native editing/batch regressions and new resilience checks. The installed extension completed genuine Task C with disposable broken providers and the already configured Gemini fallback. No model-provider calls were made by the extension itself.

**Overall competition readiness remains incomplete: Phase 3 official Task B is still pending.** It was not rerun, pre-applied, or relabelled as successful. Physical UI clicks and the submission recording remain NOT TESTED. No GitHub PR operation, branch creation, merge, push or publication was performed.

## 2. Official source and required behavior

Read the retained official PDF `/tmp/forgepilot-spec.pdf` and its extracted `/tmp/forgepilot-spec.txt`, task table and B3 rubric. PDF SHA-256: `5feeee151edc6bf098743e6eaf5e87b8996adc7bc13abbe1fc8409074d6ddb49`.

[Official competition source](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf), exact Task C instruction:

> Configure TrueForge with an unreachable endpoint or an invalid key, then repeat Task A.

The verification column requires a responsive editor, clear error or automatic takeover by another configured model, and unchanged Git status. The rubric distinguishes unsafe hangs/changes, safe clear errors, backoff followed by safe failure, and automatic fallback. Same-provider backoff is **not implemented**; this implementation takes the configured-fallback path. Multiple error categories, both-provider failure, cancellation races, inline session isolation, exact undo and guarded multi-file recovery are additional engineering requirements rather than invented official Task C wording.

The test sends the exact Task A instruction to the selected function in the pinned checkout. Failure scenarios never approve/apply changes. Successful fallback first proves the workspace is unchanged with a native proposal visible, then separately exercises explicitly approved application, behavioral verification and undo.

## 3. Failure classification

`failure.ts` defines `RequestFailure`, origin (`provider`, `transport`, `local`), HTTP status, original internal cause, recovery eligibility and fixed sanitized messages. Categories cover credentials/401, forbidden/403, missing/invalid model, 429, daily quota, 502/503/504, networking/DNS/refused connections, timeout, SDK/stream failure, malformed proposals, denied approval, cancellation, conflicts and restricted-agent policy.

Only bounded error metadata and terminal error messages are inspected; bodies/headers/prompts/source are not serialized for classification. Successful terminal status with no outstanding actions remains mandatory. Unknown, cancelled, incomplete, refused and truncated outcomes remain closed to application. A stable branded error survives separate VS Code/test module bundles. `publicError` and structured logs expose safe messages/metadata, not raw causes. The inline live driver's error output also now uses `publicError` consistently.

Deterministic assertions cover HTTP extraction, original cause preservation, sanitization, exact category/eligibility and the distinction between model errors and invalid edits. Malformed draft diagnostics remain inside TrueForge's tool loop; they do not trigger model switching.

## 4. Fallback state machine and configuration

Idle → primary setup/stream/approval → success; or eligible failure → invalidate/cancel/revoke → fallback setup/stream/approval → success/failure. Cancellation at any asynchronous boundary prevents switching/adoption.

Machine-scoped settings:

| Setting | Default / rule |
| --- | --- |
| `forgepilot.fallbackEnabled` | `false`; explicit opt-in |
| `forgepilot.fallbackAgentName` | empty; must identify a distinct saved agent |

Repository settings cannot authorize a fallback model. No paid model is chosen automatically. The selected agent's usual configured model charges still apply. At most **one automatic transition per user request**; no recursive fallback, same-provider retries, or repeat application. Two failures produce a clear message containing both sanitized categories. The next manual request can start fresh without restarting VS Code.

The editor initializes inference within cancellable request progress; the explicit Start command still creates a real session. An unused explicitly started primary session may serve the next request. New requests otherwise get fresh execution state.

## 5. Session and connector isolation

Inspected actual SDK `CreateSessionRequest`, `CreateSessionAgent`, `SessionAgentSpecBody`, `SessionAgentInline`, `AgentSpec`, terminal-state declarations and serializers. Runtime **0.185.1 genuinely accepts `agent: { spec: ... }`**. The extension snapshots a saved agent into that inline session and attaches only its randomly named authenticated companion connector. It does not update the shared saved agent manifest. Each turn revalidates the actual inline session's capability/approval policy.

Sandbox, dynamic subagents, web search, memory and generative UI must remain explicitly disabled; no skills or unrelated MCP connectors are accepted. Model existence is checked through the SDK catalog. The legacy standalone `Bridge` named-session mode remains supported for Phase 1/2 regressions; those scripts should still run sequentially against a saved agent.

Each fallback uses another Bridge, session, connector/token, call/source map, request scope and candidate store. Failed stores are cancelled before retry; target UI stores receive only successful-terminal, freshly revalidated proposals. No approval, draft ID, event ID, partial conversation or staged file from the failed attempt is copied. `BatchStore.fork()` preserves only the authorized workspace/baseline reader.

## 6. Approval, failure and cancellation guarantees

Genuine SDK tool approval is separate from extension hunk decisions. Inline and batch proposal payload/source checks remain intact. Every new fallback proposal needs fresh staging permission; all UI hunks initially remain pending. Model output cannot approve or apply its own edits.

Cancel/Stop abort pending setup/turn operations, invalidate draft/request generations, request backend cancellation where applicable and close owned workspace access. Delayed callbacks/results cannot revive cancelled stores. A deadline during model execution can qualify for fallback; a deadline while waiting for a person is **local**, cannot switch models, and cannot submit a delayed allow. A real ten-second deterministic approval-wait test asserts this boundary. Developer denial takes precedence even when submitting the deny event fails; a dedicated SDK-503 regression verifies no fallback. Generation timers are cleared when a failure is observed, so cleanup latency cannot recategorize it as a new deadline.

No model operation writes files. No changes proposed, staged-unapplied changes, and already applied changes are handled separately. Recovery invalidates uncommitted generations. It never claims to reverse an already accepted application; existing guarded undo/coordinator restoration remains responsible for that state. Existing stale-buffer, disk hash, identity, link, path and partial-application assertions are retained.

## 7. Responsiveness and resource bounds

All SDK I/O remains asynchronous and cancellable. Progress notifications and cancellation listeners settle through `finally`; VS Code owns native question presentation, and cancelled requests ignore late answers; operation busy flags reset. One nonblocking information notice accompanies a fallback; one final error is presented per failed user command. Cancellation is recorded without an error popup.

Individual bounds: control-plane SDK requests 10 seconds, backend cancellation five seconds, private draft IPC five seconds, companion termination escalation 2.5 seconds, and a configurable 10–600-second generation deadline per attempt (45 seconds in Task C). Cleanup is awaited before fallback; failed registry cleanup stops switching and revokes the companion. These are bounded operations, **not a hard real-time overall transaction/SLA**.

Installed-VSIX Task C kept a 25ms extension-host timer running: **802 ticks**, maximum observed gap **125 ms**, with an assertion that it never stalled for one second. The contributed-command failure-only run also passed. This is actual event-loop evidence, not a claim of physical keyboard/mouse testing.

## 8. Actual saved models and isolated test configuration

Preserved, without manifest/credential/endpoint changes:

| Agent | Actual registered model |
| --- | --- |
| `forge-coder-openrouter` | `openrouter/nemotron-3-ultra-free` |
| `forge-coder` | `google-gemini/gemini-3-1-flash-lite` |

Gemini availability was first verified by genuine streaming/MCP inference. Test-only providers/agents use cryptographically unique `forgepilot-c-*` names. Authentication testing uses the real OpenRouter endpoint and an intentionally invalid **nonsecret** key; its underlying configured model ID is `nvidia/nemotron-3-ultra-550b-a55b:free`. Network testing uses a reserved-then-closed high loopback port. The test configuration is explicitly provisioned in TrueForge, not a mocked inference result. Real provider settings and API keys are never read/exported or overwritten.

The test suite explicitly chooses `forge-coder` as fallback in a disposable VS Code profile. It does not enable fallback in the user's normal profile. Both original agent manifest hashes are rechecked after the test; temporary providers/agents/connectors are removed. Final SDK inspection confirms both agents' restrictions, zero permanent tool attachments/skills and no leftover owned registrations.

## 9. Deterministic and regression matrix

| Command/check | Result | Evidence |
| --- | --- | --- |
| `npm ci` | PASS; 227 packages installed, lockfile unchanged | `artifacts/phase4-install.log` |
| `npm run check` | PASS; strict TypeScript/ESLint, **79/79**, no failures/skips | `artifacts/phase4-check.log` |
| Node **22.23.5**: `npm exec --yes --package=node@22 -- npm run check` | PASS; **79/79** | `artifacts/phase4-node22.log` |
| Node **24.22.3**: corresponding node@24 command | PASS; **79/79** | `artifacts/phase4-node24.log` |
| `npm run test:live` | PASS; actual Gemini streaming, repository MCP reads, hashes, cleanup | session `01m7s7k7vjwgvqpjwj33a4k0p4`; `phase4-live.json` |
| `npm run test:editing:live` | PASS; actual staging approval, mixed hunks, SDK cancel while streaming/waiting | session `01m7s85mbbz3c3w3vm5rm9k3x1`; `phase4-editing-live.json` |
| Actual development host | PASS; commands, native inline/batch edits, rollback/undo, new SDK-wire resilience | `phase4-host.log`, exit 0 |
| Actual installed VSIX host | PASS; all **25** command contributions/registrations, activation, native safety suites | `phase4-installed-host.log`, exit 0 |
| Installed VSIX real Task C | PASS; scenarios A/B/C/D and staged cancellation | `phase4-taskc.json`, `phase4-taskc.log`, exit 0 |
| Actual contributed failure commands | PASS; A/B/D through `forgepilot.inlineEdit` production error handler | `phase4-taskc-ui.json`, `phase4-taskc-ui.log`, exit 0 |
| Flask behavioral regression + helper tests | PASS; off/OFF/n/N false; existing values preserved; **35 passed**, exit 0 | Task C artifact |
| `npm run package:extension` | PASS; 10-file local VSIX, 485583 bytes | `phase4-package.log` |
| `npm audit --json` | PASS; currently **0** findings | `phase4-audit.json` |
| Physical palette/input/modal/tree clicks, video, Windows/macOS | NOT TESTED | Manual procedure below |
| Official Phase 3 Flask Task B | STILL INCOMPLETE; NOT RERUN | Preserved Phase 3 reports/artifacts |

The original 65 tests are preserved. Fourteen additions cover taxonomy/sanitization, machine-only configuration, SDK session/connector ownership, failure before/after staging, separate approvals, two failures, subsequent success, invalid/missing fallback, no fallback after invalid proposals or denial, primary/preparation/secondary cancellation, autonomous isolation, external edits, human approval deadline, and failed SDK denial submission. Existing tests cover stream errors during approval, delayed results, workspace containment/symlinks/hardlinks, batch conflict/rollback/undo and Phase 1 behavior. SDK-wire fixtures are clearly labelled and are not counted as real provider evidence.

The 22/24 jobs match `.github/workflows/check.yml`. Project dependency audit output is a current advisory-feed result, **not evidence of a patched advisory**. There is no dependency/lockfile update. Historical withdrawn-advisory details remain in Phase 2.1's dated follow-up. The pinned ephemeral VSCE packager is external development tooling and its full dependency tree is not audited by the project audit.

## 10. Genuine Task C results

Fresh isolated Flask checkout: `/tmp/forgepilot-flask-taskc`; version 3.1.3, commit **`22d924701a6ae2e4cd01e9a15bbaf3946094af65`**, initially clean. Selected `get_debug_flag` in `src/flask/helpers.py`; exact Task A instruction is recorded in the artifact. No prepared patch, manual Flask implementation or destructive Git reset was used.

| Scenario | Installed full-suite sessions | Result |
| --- | --- | --- |
| A: invalid key | `01m7sa0prjt9181wfbwm26sqkn` | PASS; real HTTP 401, credentials category, 1551 ms, unchanged workspace |
| B: closed endpoint | `01m7sa0qwkpykptk5psbss2bsc` | PASS; real network failure, 451 ms, unchanged workspace |
| D: both unavailable | `01m7sa0rpyayc8trypncq8kg2r` → `01m7sa0sdt166fk46mzmyth0af` | PASS; exactly two attempts, 1446 ms, no approval/application, cleanup |
| C: automatic fallback | `01m7sa0t991adafw5116p4szq3` → **`01m7sa0v8twwynmrevgnpjzs08`** | PASS; credentials failure → genuine Gemini proposal, fresh connector/session/approval |
| E: cancel staged fallback | `01m7sa1353h93hed5draa44gnt` → `01m7sa13thtyc10bjj8mp0em6v` | PASS; staged proposal invalidated, apply refused, disk unchanged |

The automatic-fallback models were **`forgepilot-c-auth-e823480a3b/test-model`** and **`google-gemini/gemini-3-1-flash-lite`**. The primary's token metrics were zero. The successful secondary reported **5420 input**, **1221 output**, **6641 total**, and **852 reasoning** tokens. No monetary cost was supplied.

The first primary connector was absent from the TrueForge registry before fallback staging approval. Native diff original/proposed contents were asserted exactly. The actual proposed diff contains two hunks: false-value docstring and the case-insensitive false set. Every hunk received an explicit automated accept command; buffers were applied/saved through ForgePilot. Behavioral assertions cover empty/unset, 0/false/no and their tested cases, off/OFF/n/N, and truthy existing values. `pytest tests/test_helpers.py -q` returned:

```text
...................................                                      [100%]
35 passed in 0.10s
exit code: 0
```

Guarded undo restored/saved the preceding original file. Final `git status --porcelain` is **empty**. The actual applied diff, hunk IDs/decisions, actual SDK approval-call/source IDs and terminal metrics are in `phase4-taskc.json`. No files remain modified in the Flask checkout.

## 11. Failure presentation and recovery traces

A separate installed-host pass drives the real contributed inline command, allowing its production command handler to present sanitized errors. It uses only failing providers and no successful model generation:

| Scenario | Sessions | Timing |
| --- | --- | --- |
| Invalid key | `01m7s95pfa4v92p9yp530d3cex` | 1011 ms |
| Unreachable | `01m7s95qh8hxv3fn92tr4ej8ab` | 404 ms |
| Both fail | `01m7s95r0hjj4py4s6tsdrcgtc` → `01m7s95rcr2dy2ym25ws16jxya` | 725 ms |

These invoke the actual notification/Output error handler; physical rendering/clicks were not independently inspected. Errors reveal safe category and remediation, not the invalid key or raw response. Both-provider handling does not enter an infinite loop, and deterministic/native tests prove a successful next request without restarting the extension.

An initial concurrent GUI-host regression lost editor focus while another VS Code test window ran. The failure log is preserved as `phase4-host-concurrent-failure.log`; the fixture now awaits the actual selected editor with a bounded wait, and GUI suites are run sequentially. Selection validation was not relaxed.

Initial live diagnosis was preserved locally: attempt 1 missed TrueForge's actual `AuthenticationError: 401` format; attempt 2 exposed separate bundle identity rather than a provider problem; attempt 3 found port 9 rejected as a forbidden HTTP port, so it was replaced with a real closed high port. The category/status parser, stable error brand and test endpoint were corrected, not bypassed. Attempts 1–3 did not produce or apply a patch. Development and final installed full suites subsequently passed. This was not a sequence of expensive Task B retries.

## 12. Packaging and reproducibility

The final installed extension path is `/home/nipun/.vscode/extensions/nipunkalsotra.forgepilot-0.1.0`. Its bundles match the repository build:

- extension SHA-256: `358b5834e1de6c793ecb740e12830137b4248ec1754a71b46c99e1aee0f73da6`.
- companion SHA-256: `3998459d4f8d3a8a648f49776725cdf2a03115a98f6d71bf2a57ed3b41efdfb2`.

```sh
npm ci
npm run check
npm run test:live
npm run test:editing:live
VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension
npm run package:extension
code --install-extension ./artifacts/forgepilot.vsix --force
```

Prepare a NEW clean pinned Flask checkout and test venv, then:

```sh
FORGEPILOT_FLASK_ROOT=/absolute/path/to/clean-pinned-flask \
FORGEPILOT_FLASK_PYTHON=/absolute/path/to/venv/bin/python \
VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:taskc
```

Use `FORGEPILOT_EXTENSION_PATH` for the actual installed extension directory. `FORGEPILOT_TASKC_UI_ONLY=1` runs only contributed-command safe-failure scenarios and saves `phase4-taskc-ui.json`; it does not spend healthy model requests. The suite assumes the tested local TrueForge mode; normal optional OIDC token storage remains supported by the production extension. It provisions only uniquely owned test models and deletes them in cleanup. Original production agent manifests are hash-checked; no provider credentials are exported. Artifacts are local/ignored; real sessions remain in TrueForge history.

## 13. Security and concurrency limits

WorkspaceEdit remains an editor operation, not a filesystem transaction/CAS. A concurrent writer can race after the final validation; guarded undo refuses unrelated subsequent edits. Request stores/history are in memory. There are no arbitrary shell, agent write/delete/rename or application tools. Fallback requires a configured agent and cannot supply provider capacity or bypass model policy/quota. Same-provider retry/backoff is not claimed. SDK transport timeouts may have ambiguous remote outcomes; closed companions revoke their filesystem access, and a registry-cleanup failure is reported rather than ignored.

The primary production OpenRouter agent's current valid-key availability and Task B ability were not retested during Phase 4. Successful automatic fallback here used an isolated intentionally invalid OpenRouter provider and the genuinely healthy saved Gemini agent. This is not a claim that the original OpenRouter quota reset or Phase 3 tuning passed Task B. Linux is the verified platform.

## 14. Exact changed files

Relative to preserved checkpoint **`e51c2c7`**, **24 files**:

- `README.md`
- `docs/architecture.md`
- `docs/phase-4-verification.md`
- `package.json`
- `scripts/verify-editing-live.ts`
- `scripts/verify-taskc.ts`
- `src/autonomous.ts`
- `src/batch.ts`
- `src/bridge.ts`
- `src/completion.ts`
- `src/editing.ts`
- `src/errors.ts`
- `src/extension.ts`
- `src/failure.ts`
- `src/log.ts`
- `src/resilience.ts`
- `tests/config.test.ts`
- `tests/extension-host.ts`
- `tests/failure.test.ts`
- `tests/resilience-fixture.ts`
- `tests/resilience-host.ts`
- `tests/resilience.test.ts`
- `tests/taskc-host.ts`
- `tests/timeout.test.ts`

`failure.ts`/`errors.ts`/`log.ts` implement typed sanitized failures; `resilience.ts` owns bounded session recovery; Bridge adds optional isolation/abortable setup and deadline distinctions; BatchStore supplies an empty fork; UI controllers accept the shared connection contract. Extension settings/progress/notifications use that coordinator. Scripts/tests provide real and deterministic evidence; README/architecture/report document actual behavior. No Phase 3 test or source module was removed; no provider/agent config, lockfile or CI rule was changed.

## 15. Remaining manual checks and unresolved work

**NOT TESTED:** physical command-palette invocation, warning-button clicks, mouse/keyboard latency, normal-window Reload action, judge walkthrough/video and macOS/Windows. To reproduce: reload the installed normal window (or F5 into a new Development Host), trust a disposable local workspace, configure fallback explicitly in User settings, select Task A, run Edit Selection, observe the failure or model-switch information, inspect the native diff, permit staging, decide each hunk, apply/save and verify. Separately cancel while preparing/streaming/waiting and try a conflicting edit/guarded undo. Never damage real provider keys/endpoints; use the disposable test harness for failure provisioning.

**Phase 3 Task B is still incomplete.** Its historical failure artifacts/reports were preserved. No full Task B request was made during this task. Successful Task B, physical recording and submission artifacts remain competition blockers. No unresolved project dependency finding is reported by this audit, but this does not assert all external tooling or providers are vulnerability-free.

## 16. Verdict and Git delivery

**Phase 4: PASS** for implemented resilience, deterministic safety, genuine isolated Task C, actual fallback, editor-host responsiveness, installed extension and required regressions. **Competition readiness: CONDITIONAL / NOT COMPLETE** because Task B and human submission checks remain outstanding.

Delivery stays exclusively on `feat/phase-3-autonomous-agent`, preserving `e51c2c7` and all earlier commits. The validated local commit uses **`feat: implement safe model resilience and Task C recovery`**; its resulting SHA is in the engineering handoff. PR #1 was not modified. No push, merge or publication was performed.

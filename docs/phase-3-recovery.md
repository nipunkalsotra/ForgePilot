# Phase 3 recovery

**19 November final-acceptance update:** Official Task B executable acceptance now passes after genuine model-generated multi-turn corrections, fresh TrueForge staging and native hunk decisions. The original three-file request contained no filenames; source, tests and documentation were discovered independently. CLI tests: **59 passed**; CLI/help/masked JSON verified. See [final acceptance](phase-3-final-acceptance.md) for current evidence, regressions and limitations. Earlier FAIL/INCOMPLETE sections below are preserved historical recovery records, superseded for Task B by that report. The original recovery was later delivered in `5dec056e`; current Phase 5 work is uncommitted by request. See [Phase 5 verification](phase-5-final-verification.md) and the [durable Task B archive](evidence/task-b/README.md).

19 November 2026. Starting branch `feat/phase-3-autonomous-agent`, clean at user-created checkpoint `e687e59`. Earlier Phase 3 work is preserved. This report is updated with actual execution results below; pending checks are not passes.

## Historical root causes (before protocol changes)

Read-only SDK inspection of all 17 sessions is retained in `artifacts/phase3-failure-analysis.json`. Counts below include TrueForge deferred-system calls; usage is cumulative input plus output reported by TrueForge, not the per-package context estimate. Source contents are excluded from the analysis output.

| Attempt | Calls | Total tokens | Proven failure / owner | Feedback and safe recovery |
| --- | ---: | ---: | --- | --- |
| 1 | 13 | 52,100 | Wrong `lines` arguments to deferred range reads; repeated calls; unsuccessful/cancelled completion. Model/tool-protocol mismatch; no proof of a provider outage | Tool schemas were available, but feedback insufficient to correct arguments; improve eager schemas and short guidance |
| 2 | 12 | 113,879 | ForgePilot lacked native question response handling at that point | Client cancelled; supported question handling was added before this recovery |
| 3 | 17 | 179,421 | Provider quota, with earlier wrong read/deferred arguments | Tool errors received; quota requires provider capacity, not bypassing validation |
| 4 | 15 | 201,336 | Model repeated the same source path three times in `propose_batch`; extension rejected preapproval | Correct rejection, but no in-turn recovery after extension preflight failure; independent drafts needed |
| 5 | 21 | 350,441 | Model mixed wrapper fields into batch, omitted operation and used empty anchors | Generic schema failure; independent structured diagnostics needed |
| 6 | 18 | 224,359 | Model used empty insertion anchors in source and tests | Generic preapproval failure; read exact anchors and validate drafts before staging |
| 7 | 0 | 0 | Provider HTTP 503/high demand | No tool or proposal to recover |
| 8 | 8 | 104,795 | Model omitted operation from all file proposals; repeated context query | Extension rejected batch; per-file diagnostics needed |
| 9 | 0 | 0 | Provider connection failure | No tool or proposal to recover |
| 10 | 14 | 174,087 | Invalid original anchor in `propose_batch`; extension exact-match rejection | No model-visible correction before cancellation; read-only per-file validation needed |
| 11 | 0 | 0 | Provider connection timeout | No tool or proposal to recover |
| 12 | 0 | 0 | Provider connection timeout | No tool or proposal to recover |
| 13 | 0 | 0 | Provider free-plan quota zero | No safe client-side retry can supply quota |
| 14 | 5 | 50,140 | Provider overload after valid retrieval | No approved proposal; availability is external |
| 15 | 27 | 598,358 | Provider input-token-per-minute quota | Repeated cumulative context is material; reduce duplicate discovery and patch retransmission |
| 16 | 1 | 4,137 | Provider connection failure (generic UI message hid detail) | No approved proposal; do not call this a patch failure |
| 17 | 25 | 445,058 | Provider high demand after `check_batch` rejected an escaped anchor, followed by a source-only valid draft | Agent received actionable anchor feedback, but had to resend full patches; retain independently validated file drafts |

Malformed drafts above are not attributed to outages. Broad string matches in source text are not treated as provider failures. Session terminal states supply provider categories. Cancelled states do not establish why a provider would have failed.

## Missing commands

The normal `/opt/visual-studio-code` profile listed no `nipunkalsotra.forgepilot` installation. Opening the repository alone does not load its extension. Existing bundles, `main`, command contributions, launch/build configuration and registrations were valid. Earlier automated runs used an isolated Extension Development Host, which did not install ForgePilot into the normal profile.

Added a pinned official VSCE packaging command and excluded local artifacts/test bundles. Actual host regression now invokes a contributed command to activate ForgePilot, checks the loaded path/bundle, all 25 registrations/titles, and an empty autonomous invocation without model requests. It passed with exit 0. VS Code's `getCommands` enumerates registered commands; it does not prove palette UI rendering before activation. Physical palette clicks remain NOT TESTED.

Final `npm run package:extension` produced a local ten-file VSIX (467.47 KB), excluding session artifacts, source maps and test bundles. It was force-installed into the normal profile. A fresh actual host loaded `/home/nipun/.vscode/extensions/nipunkalsotra.forgepilot-0.1.0` and passed activation, every command and editor regressions (exit 0). Its bundle SHA-256 values match the repository build: extension `12bb541c3141f89054385eeac5cd496238c947ef8cd5e989e62f170ab79cca99`, companion `218cd9faba50f1ecda7ad27ad13ac3f9f12ace1003a33359e5b855ca0e26b882`. The ordinary existing window still needs the documented Reload Window step for independent physical verification.

The supported VS Code versions [activate contributed commands automatically](https://code.visualstudio.com/api/references/activation-events); absence of explicit activationEvents was not a defect. Local packaging/install follows the [official VS Code workflow](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). No extension was published.

## OpenRouter configuration inspected

Saved agent `forge-coder-openrouter`, ID `01m7r0mk2k23qermv2jfemmd6j`, uses actual registered model `openrouter/nemotron-3-ultra-free`. SDK model catalog reports underlying ID `nvidia/nemotron-3-ultra-550b-a55b:free`, provider `openrouter`, one-million-token context, 16,384 maximum output tokens, and advertised reasoning effort `high`. Endpoint inference support still requires live verification. Initial agent reasoning is `high`; sandbox, dynamic subagents, web search, memory and generative UI are explicitly disabled, no skills, MCP list empty. Gemini `forge-coder` is preserved. No provider credentials or endpoints are modified or exported.

## Implemented recovery

- `src/drafts.ts`: bounded independent file validation, typed diagnostics, one retained draft per path, superseded IDs, full-batch revalidation, exact anchor checks and no writes. Drafts are limited to 12 files/90,000 serialized bytes. Private IPC begins/invalidate scopes; completion/cancellation clear them and delayed validations cannot revive retired scopes. `list_drafts` recovers IDs after compaction. At most 64 retired scopes are retained before requiring a new session.
- `src/mcp/autonomous.ts`: `draft_file`, `list_drafts`, `check_drafts`, `check_anchor`, `propose_drafts`; retain compatible `check_batch`/`propose_batch`. There are now 15 autonomous-mode tools including the three legacy tools. `check_batch` diagnoses independent files even when another file is malformed or duplicated. Operation enums, hash/anchor descriptions and variant-specific guidance are explicit.
- `src/bridge.ts`: start with one context retrieval, avoid mandatory inventory/schema round trips, cache genuine validated draft arguments, correlate final IDs/source/call, require both proposal tools' actual approval policy, revalidate before approval, reject a final payload differing from approved contents, and preserve strict successful terminal handling. Actual terminal metrics are available separately from estimated context bytes.
- A final setup-window regression cancels while draft IPC initialization is held and asserts that zero TrueForge turns are created. A request epoch and pending-operation guard prevent delayed setup from starting inference or overlapping requests; workspace initialization also rechecks cancellation before creating a store.
- `src/companion.ts`, `src/mcp/child.ts`, `src/mcp/server.ts`: acknowledged private draft-scope IPC, cancellation/completion invalidation, bounded memory and cleanup, preserving existing MCP process/authentication lifecycle.
- `src/patch.ts`, `src/workspace.ts`: typed error codes without relaxing existing validation/messages, containment, links, UTF-8 or size bounds.
- `src/autonomous.ts`: expose actual TrueForge metrics in the context inspector. Existing native review/coordinator/undo remain intact.
- Test drivers select OpenRouter through `TRUEFORGE_AGENT_NAME` in a disposable profile; no permanent change to the normal profile's agent setting. Task B pacing defaults to 0 ms; staging and per-hunk decision sequences are captured. The generic live fixture uses implementation/tests/documentation with no filenames in the request.

## Actual OpenRouter health and three-file result

| Session | Result | Evidence |
| --- | --- | --- |
| `01m7r21cm9gb4pbfmrcc5np8b5` | PASS | Eight text deltas, genuine `list_files`/`read_file`, unpredictable marker, unchanged disk, cleanup. Two tool calls; 5,781 total tokens |
| `01m7r24bjbvexmc1gr53g4dtnx` | PASS | Genuine structured inline proposal and approval, two independently reviewed hunks, SDK cancellation while awaiting permission and streaming. First completed turn 5,524 tokens |
| `01m7r25dfsccy27hkrxsq6me9y` | PASS | Real model discovered `switch.py`, `tests/test_switch.py`, `README.md`; nine tool calls; native VS Code diffs, explicit automated staging/hunk decisions, apply/save, three passing unittest cases, additional mixed-case behavior assertion, exact three-file undo, connector cleanup |

The generic live context estimate was **733/12,000 tokens**, with three candidates. TrueForge supplied **56,279 input**, **2,372 output**, **58,651 total**, **26,304 cached**, **541 reasoning** tokens. No cost was supplied. This passed before the later scope/schema/compaction hardening; those final refinements have deterministic and native-host coverage but no successful repeated live three-file run after the quota was exhausted. Evidence: `artifacts/openrouter-health.json`, `openrouter-inline.json`, `openrouter-three-file.json`.

The endpoint accepted the existing **high** reasoning setting. No lower-effort substitution or other model fallback was made for Task B. Provider endpoints, keys, billing and original Gemini manifest were not changed.

## Recovery Task B attempts and root causes

Both started from fresh clean clones at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`; no prepared solution or file names were injected. The official wording was reread from the preserved specification PDF/text; the current web fetch was unavailable. The exact request is stored by the driver alongside session evidence.

| Attempt/session | Calls / supplied total usage | Actual failure and subsequent fix |
| --- | --- | --- |
| `01m7r2bx44ctjb2kh7swerqr1x` | 18 / 401,027 | After native compaction, model supplied a zero placeholder request ID, `operation=edit`, and an invented hash. MCP returned `INVALID_OPERATION`; the bridge then cancelled on scope mismatch even though this was a read-only failed draft. Scope ownership moved to private bridge/companion IPC, so the model no longer supplies IDs. This was a model/protocol defect, not an outage |
| `01m7r2vj915aptcr7jq4yar0zn` | 23 / 388,796 | Scope handling remained valid. Five drafts were invalid: create combined with replacement fields, then edit; hashes also included fabricated values. No valid final batch/approval. Terminal error explicitly reported **`Rate limit exceeded: free-models-per-day`**. Subsequent fixes advertise exact operation enums and variant guidance and raise the compaction trigger to 64,000. These last changes remain live-unverified |

The last session reported input **381,020**, output **7,776**, cached **258,656**, reasoning **1,846** tokens. It made one context query and 17 distinct range reads; there was no repeated inventory or identical range query. The context package estimated **6,523/12,000** tokens and independently selected `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, plus related history. Selected-file reasons include actual path/lexical/import/counterpart evidence, recorded verbatim in the artifact.

Both sessions contain genuine `thread.context_compaction_started`/`finished` events at the initial 32,000 trigger. Metadata and operation conventions were subsequently lost/invented; the final 64,000 threshold retains more original context before compaction. This is evidence-based tuning, **not a verified successful final run**. Failed-turn usage is not a completed-task efficiency benchmark. Removing the serialized 10-second delay avoids at least 230 seconds of artificial waiting across 23 responses; it does not supply quota or automatically retry inference.

No further OpenRouter attempt was made against the proven daily account limit. No credentials, endpoints or billing settings were changed. Historical failures are preserved in `phase3-taskb-attempt1..16.json`, `phase3-taskb-before-recovery.json`; recovery failures in `phase3-openrouter-attempt1.json`, `phase3-openrouter-attempt2.json`. The current `phase3-taskb.json` is the failed second recovery run. `scripts/analyze-failures.ts` reads all **19 unique failed sessions** without model calls or source/error-body dumps.

**Flask Task B: FAIL / INCOMPLETE.** Both recovery checkout Git diffs remain empty. No final staging/hunk decisions occurred. Post-change `pytest tests/test_cli.py -q`, `flask --help` config registration and masked JSON are **NOT TESTED**. Earlier unmodified baseline CLI success is not counted as feature acceptance. No Flask implementation was manually written.

## Final regression evidence

| Check | Result |
| --- | --- |
| `npm ci` | PASS; 227 installed, zero reported vulnerabilities; lockfile unchanged |
| `npm run check` | PASS; **65 tests**, no failures/skips, strict TypeScript/ESLint |
| `npm exec --yes --package=node@22 -- npm run check` | PASS; Node **22.23.5**, 65 tests |
| `npm exec --yes --package=node@24 -- npm run check` | PASS; Node **24.22.3**, 65 tests; log `artifacts/ci-node24.log` |
| Actual VS Code host | PASS; command activation/all 25 contributions, generic three-file diffs, mixed decisions, creation, coordinated apply/undo, stale edits, rollback/error/cancellation assertions |
| Final installed VSIX host | PASS; loads installed path, hashes match, all commands/activation and editor checks; exit 0 |
| Original Phase 1/2/2.1 cases | PASS; all preserved |
| Final `npm run test:live` | PASS; original Gemini, session `01m7r3cjg9d5s0sd5cfekajezy`, real discovery/read/streaming/cleanup |
| Final `npm run test:editing:live` | PASS; original Gemini, session `01m7r3yfv5ht1zdr3dk6a8c45p`, real approval and cancellation |
| Fresh actual-host Flask Task A | PASS; original Gemini, session `01m7r40wp949w49e9wcvdfcgvy`, two native hunks, exact undo, off/OFF/n/N false and existing behavior preserved |
| Task A `pytest tests/test_helpers.py -q` | PASS; **35 passed**, exit 0 |
| Official OpenRouter Flask Task B | FAIL; no approved complete batch; daily quota and malformed drafts documented above |
| Final scope/schema/64k tuning in a successful live Task B | NOT TESTED; quota prevents it |
| Physical palette/input/warning/tree clicks; judge recording; macOS/Windows | NOT TESTED |

The original Gemini was used only for regression checks, explicitly distinguished from OpenRouter Task B. Tests did not silently substitute another model for that task. Unit/SDK fixtures remain labelled; they are not real-model acceptance evidence.

## Exact recovery files

Relative to preserved checkpoint `e687e59`:

| Files | Purpose |
| --- | --- |
| `.vscodeignore`, `package.json` | Build/package workflow, exclude local evidence/test bundles, include draft unit tests |
| `README.md`, `docs/architecture.md`, `docs/phase-3-verification.md`, `docs/phase-3-recovery.md` | Installation, actual architecture, current verification and this root-cause report |
| `docs/phase-2-hardening.md` | Dated follow-up explaining the now-withdrawn upstream advisory; historical gate preserved |
| `config/forge-coder-openrouter.agent.json`, `scripts/setup-openrouter.ts` | Actual credential-free agent definition and guarded agent-only setup |
| `scripts/analyze-failures.ts` | Read-only historical metrics/diagnostics analysis |
| `scripts/verify-editing-live.ts`, `scripts/verify-extension.ts` | Isolated agent/installed-host selection and expected-bundle evidence |
| `src/drafts.ts`, `src/patch.ts`, `src/workspace.ts` | Bounded validated drafts and typed secure diagnostics |
| `src/bridge.ts`, `src/autonomous.ts` | TrueForge draft/approval correlation, proposal equality, observable actual usage |
| `src/companion.ts`, `src/mcp/child.ts`, `src/mcp/server.ts`, `src/mcp/autonomous.ts` | Private scope IPC, memory lifecycle and new bounded tools |
| `tests/drafts.test.ts`, `tests/approval.test.ts`, `tests/mcp.test.ts` | Corrections, lifecycle, exact approval, mismatched results and no-write transport assertions |
| `tests/batch-host.ts`, `tests/extension-host.ts`, `tests/autonomous-host.ts`, `tests/autonomous-live-host.ts` | Generic real/deterministic editor workflows, every command, Task B decision evidence |

## Reproduce and remaining gates

```sh
npm ci
npm run check
npm run package:extension
code --install-extension ./artifacts/forgepilot.vsix --force
# Reload the intended normal VS Code window, or use F5 in this repo.

TRUEFORGE_AGENT_NAME=forge-coder-openrouter FORGEPILOT_AUTONOMOUS_LIVE=1 \
  VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension

# Only after account/provider capacity is available, using a NEW clean pinned clone:
TRUEFORGE_AGENT_NAME=forge-coder-openrouter FORGEPILOT_PHASE3_FLASK=1 \
  FORGEPILOT_FLASK_ROOT=/absolute/path/to/clean-flask-22d92470 \
  FORGEPILOT_FLASK_PYTHON=/absolute/path/to/venv/bin/python \
  VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension
```

The venv needs the checkout's Flask `[async,dotenv]` dependencies and pytest (the verified environment uses pytest <9). The driver sets PYTHONPATH and asserts the pinned commit/clean Git tree. It records native diffs, explicit automated decisions, command outputs/exit codes and final Git diff only if the real proposal succeeds. Do not apply a prepared solution to get past this gate.

Physical GUI reproduction: after reload search `ForgePilot:`, choose Autonomous Agent, type the official instruction without file names, inspect Output and context, permit staging, review each file/hunk, apply/save and execute CLI tests/help/fixture JSON. Check cancellation, a conflicting user edit and guarded undo separately. Automated host APIs do not verify these human clicks.

Current npm install/audit results report no project vulnerabilities. [The picomatch advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was withdrawn upstream on 18 November 2026, explaining the audit discrepancy; the lockfile/code was not patched. The dated Phase 2.1 follow-up preserves its historical gate. The pinned ephemeral VSCE packager is development tooling and not shipped; project audit results do not audit that external tool's whole dependency tree.

Final SDK inspection (`artifacts/recovery-cleanup.json`) confirmed both agent security restrictions, Gemini medium reasoning unchanged, OpenRouter high reasoning/64,000 trigger, empty skills and MCP attachment lists, and zero remaining temporary ForgePilot connector registrations.

Actual safety limits remain: WorkspaceEdit is not a filesystem transaction/CAS; a process can race after final validation; undo/drafts are in-memory, one active client per saved agent, heuristic bounded retrieval, no unrestricted agent shell, no persistent autonomous delete/rename operation. Only approved creation undo removes files.

**Readiness: FAIL / PHASE 3 INCOMPLETE.** Required remaining evidence is a successful real OpenRouter three-file Task B after final tuning, approved native application/save, passing post-change CLI tests/help/masked JSON and the human walkthrough. A local recovery checkpoint is appropriate; a completion claim is not. No Phase 4 work, push, publish, deployment or merge was performed.

## Git delivery

Recovery changes are isolated to the **28 files** listed above, on `feat/phase-3-autonomous-agent`. The original `e687e59` Phase 3 checkpoint and `458dd85` hardening commit are preserved. Delivery uses the explicit checkpoint subject **`fix: checkpoint Phase 3 recovery with Task B blocked`**; the actual resulting commit ID is reported in the handoff. Generated VSIX/log/session evidence remains ignored and local.

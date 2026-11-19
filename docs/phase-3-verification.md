# Phase 3 verification

**19 November final-acceptance update:** Official Task B executable acceptance now passes after genuine model-generated multi-turn corrections, fresh TrueForge staging and native hunk decisions. The original three-file request contained no filenames; source, tests and documentation were discovered independently. CLI tests: **59 passed**; CLI/help/masked JSON verified. See [final acceptance](phase-3-final-acceptance.md) for current evidence, regressions and limitations. Earlier FAIL/INCOMPLETE sections below are preserved historical recovery records, superseded for Task B by that report. No commit or push is authorized for this final recovery.

Updated: **19 November 2026**, branch `feat/phase-3-autonomous-agent`. Recovery began from the user's clean checkpoint `e687e59`; Phase 2.1 remains committed as `458dd85`.

## 1. Executive summary

**Phase 2.1: PASS. Phase 3: FAIL / INCOMPLETE.** The extension loads all 25 commands, the new OpenRouter agent genuinely streams and calls MCP tools, and a real generic three-file task passed native diff review, explicit automated approval/application, behavioral checks and exact undo. The final deterministic suite has **65 passing tests**, including every original Phase 1/2 case, with strict checks passing on Node 22 and 24.

**Official Flask Task B has not passed.** Two recovery attempts independently found implementation/tests/docs. The first exposed a draft-scope/protocol defect; the second produced malformed drafts then exhausted OpenRouter's daily free-model quota. Neither reached final approval or modified Flask. The final schema/scope/compaction refinements have deterministic coverage, but still need successful live Task B evidence. No prepared Flask solution was injected.

See [the complete recovery report](phase-3-recovery.md) for the 19-session failure analysis, exact recovery files and reproduction commands. The earlier verification snapshot is preserved in Git at `e687e59`.

## 2. Changed files and purpose

The recovery report lists every changed file relative to `e687e59`. New core code is `src/drafts.ts`; the existing `Bridge`, companion, MCP, native review and coordinator architecture is reused. New tests are `tests/drafts.test.ts` and `tests/autonomous-live-host.ts`. Agent setup/inspection scripts and a credential-free OpenRouter definition were added. Packaging, existing test drivers and documentation were updated. `package-lock.json` and strict CI enforcement are unchanged.

## 3. Phase 2.1 hardening

Explicit successful terminal completion remains mandatory. Error/cancelled/incomplete/unknown states, missing completion, pending actions, refused/truncated output and events after completion fail closed. Staged proposals are invalidated on failure. Original approval/cancellation/MCP lifecycle cases remain passing. Historical gate evidence and current dependency-advisory follow-up are in [phase-2-hardening.md](phase-2-hardening.md).

## 4. Autonomous architecture

One natural-language request enters `ForgePilot: Autonomous Agent`. TrueForge owns the complete model/tool loop. The companion exposes secure discovery, context, independent draft validation and proposal tools; it cannot apply files. Actual tool permission is submitted through SDK `sessions.createTurnEvents`, followed by independent developer hunk decisions in VS Code. No direct provider client, unrestricted model shell, or separate custom agent loop was added. Inline and read-only modes remain separate.

## 5. Context retrieval

Git tracked/permitted-untracked enumeration or a bounded fallback finds candidates beyond the legacy 200-file ceiling. Scope/path/identifier/symbol queries and paginated ranges retain workspace containment, deny lists, UTF-8, symlink, hardlink, descriptor and resource protections. Ranking uses real path, lexical, declaration, import and implementation/test/documentation counterpart evidence. Explicit `@file` and `@symbol` references use the same authorization boundary. Retrieval reasons, omissions and truncation are observable.

The last Task B package independently selected `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` and related history without naming those paths in the instruction.

## 6. Budget methodology and actual usage

Default context-package budget: **12,000 estimated tokens** (`ceil(UTF-8 bytes/3)`), including serialized metadata and an instruction/output reserve; configurable 2,000–32,000. Packages also respect a 20,000-character transport cap. This is distinct from cumulative provider usage; the inspector now exposes actual TrueForge terminal metrics when supplied.

Generic successful three-file run: **733/12,000 estimated package tokens**, **58,651 cumulative actual tokens**, nine tool calls. Last failed Task B: **6,523/12,000 estimated package tokens**, **388,796 cumulative actual tokens**, 23 calls. Failed runs at different stopping points are not a completed-task efficiency comparison. Task B pacing is now **0 ms**, replacing the serialized 10,000 ms test setting.

## 7. Multi-file proposal, review and application

Independent file drafts are retained in memory, one entry per path, at most 12 files/90,000 serialized bytes. Typed diagnostics distinguish duplicate targets, malformed variants, hash/anchor/overlap errors, missing/existing targets and policy failures. Exact match and original full-file hash checks remain mandatory; no fuzzy correction occurs. `check_anchor` validates bounded original snippets; `list_drafts` recovers retained IDs.

The bridge manages draft scope through acknowledged private companion IPC. The model does not supply that internal scope. Completion/cancellation invalidate drafts and ignore delayed results. `check_drafts` revalidates all selected drafts; `propose_drafts` assembles a final batch under genuine approval. The bridge rejects a response whose normalized content differs from the approved proposal. Legacy `check_batch`/`propose_batch` remain available.

Native file-grouped diffs, individual hunk/file decisions, remaining-hunk actions and keyboard review are implemented. Every hunk must be decided; only accepted content enters coordinated WorkspaceEdit. Creation is explicit and cannot overwrite. Hashes, identities and document versions are rechecked. Undo/partial-failure restoration are guarded and refuse unrelated changes. **No filesystem transaction or public version CAS is claimed.**

## 8. TrueForge integration, cancellation and model configuration

Saved agent: **forge-coder-openrouter**, ID `01m7r0mk2k23qermv2jfemmd6j`; actual registered model **openrouter/nemotron-3-ultra-free**, underlying **nvidia/nemotron-3-ultra-550b-a55b:free**. Existing **high** reasoning worked in real inference. All restricted runtime features are explicitly disabled, skills and permanent MCP attachments empty, provider credentials/endpoints unchanged. The original Gemini agent is preserved.

Historical traces demonstrate genuine deferred tool loading. Both recovery Task B sessions contain native context compaction start/finish events at the initial 32,000 trigger. After observing lost/invented original metadata, the final OpenRouter trigger was raised to **64,000**. The final tuning is **NOT live-verified** after the daily quota error. No inference or approved proposal is blindly retried.

SDK cancellation stops backend execution and client processing. Private IPC invalidates retained drafts, stores/epochs invalidate pending review, and a failed cancellation acknowledgement closes workspace access. Only the owned connector is removed; history remains available.

## 9. Automated and native-host results

| Check | Status | Actual result |
| --- | --- | --- |
| `npm ci` and fresh audit | PASS | 227 installed; zero reported findings; lockfile unchanged |
| `npm run check` | PASS | Strict TypeScript/ESLint; **65 passed**, zero failed/skipped |
| Node 22.23.5 CI-equivalent check | PASS | **65 passed** |
| Node 24.22.3 CI-equivalent check | PASS | **65 passed**; retained log |
| Existing Phase 1/2/2.1 tests | PASS | All preserved |
| Actual VS Code Development Host | PASS | All 25 commands, command-triggered activation, native multi-file/inline diff and editor assertions |
| Installed VSIX host | PASS | Actual installed directory, all 25 commands/activation, native editor regressions; both bundle hashes match the repository build |
| Real OpenRouter generic three-file task | PASS | Actual model/tool/approval/editor/behavior/undo/cleanup; preceded final scope/schema tuning |
| Final `npm run test:live` | PASS | Original Gemini; genuine read/stream/history/hash integrity/cleanup |
| Final `npm run test:editing:live` | PASS | Original Gemini; genuine approval, mixed hunks and cancellation |
| Fresh live Task A and helpers | PASS | Two native hunks, exact undo, required false values, **35 helper tests passed** |
| Final tuned live Task B | FAIL | No approved complete batch; daily quota and invalid drafts documented |
| Physical GUI clicks / judge walkthrough / macOS / Windows | NOT TESTED | Precise manual instructions in recovery report |

Unit and SDK fixtures are labelled and kept separate from real model evidence. The generic live success is not substituted for official Flask Task B.

## 10. Official Flask Task B

The exact official instruction is `TASK_B` in `tests/autonomous-host.ts`, followed only by feature clarifications (case-insensitivity, valid JSON, no leaks, tests/docs, serialization of defaults). No implementation filenames or prepared changes were provided to the model. Fresh clones at `22d924701a6ae2e4cd01e9a15bbaf3946094af65` were used:

- `/tmp/forgepilot-flask-openrouter-taskb`
- `/tmp/forgepilot-flask-openrouter-taskb2`

Both remain clean; their final Git diffs are empty. The second run had zero final staging or hunk decisions. The decisive post-change `pytest tests/test_cli.py -q`, `flask --help` registration and valid masked `flask config` JSON are **NOT TESTED**, because no approved complete feature exists. Prior baseline CLI success is not counted as feature acceptance.

The terminal provider message specifically identified **free-models-per-day**, not a transient connection error. No further account-quota retry, billing adjustment or model substitution for Task B was attempted. Invalid operations/variants and fabricated hashes preceding that terminal error are independently documented as model/protocol failures; subsequent fixes need a successful new live run.

## 11. Genuine sessions and evidence

| Session | Outcome |
| --- | --- |
| `01m7r21cm9gb4pbfmrcc5np8b5` | OpenRouter streaming/MCP health PASS |
| `01m7r24bjbvexmc1gr53g4dtnx` | OpenRouter approval/cancellation PASS |
| `01m7r25dfsccy27hkrxsq6me9y` | Generic real three-file native editor test PASS |
| `01m7r2bx44ctjb2kh7swerqr1x` | Task B failed on scope/protocol defect; no edits |
| `01m7r2vj915aptcr7jq4yar0zn` | Task B invalid drafts then daily quota; no edits |
| `01m7r3cjg9d5s0sd5cfekajezy` | Final original-agent read-only regression PASS |
| `01m7r3yfv5ht1zdr3dk6a8c45p` | Final original-agent inline regression PASS |
| `01m7r40wp949w49e9wcvdfcgvy` | Fresh final original-agent Task A PASS |

Ignored local JSON artifacts preserve all 19 failed session histories, actual retrieval reasons, proposed drafts, successful generic diffs/undo, permissions and command outputs. They are excluded from VSIX packaging. TrueForge retains original session history. No cost estimate is fabricated when cost is absent.

## 12. Security/concurrency limits

One client per saved agent; no conditional manifest-write API. WorkspaceEdit is an editor operation, not an OS transaction; races after final validation remain possible. Unknown/user-modified partial states are preserved and reported. Drafts/undo are in memory, not durable across restart. Retrieval is bounded/heuristic; estimated package counts are not global provider limits. Files may contain credentials despite permitted names; the companion inherits no provider credentials. There is no model shell or direct writer.

Current npm audit is zero. The earlier picomatch advisory was withdrawn upstream; no dependency code was patched. The packaging tool is ephemeral development tooling, excluded from the runtime bundle. Details/sources are in the recovery and hardening reports.

## 13. GUI workflow and pending checks

A repository folder alone does not install an extension. Use F5's separate Extension Development Host, or package/install the VSIX then reload the intended normal VS Code profile. The initial normal profile had no ForgePilot installation; it now lists the installed extension. Supported contributed commands activate automatically; no missing activation event was identified.

Physical palette/keybinding/input, staging warning/tree/Quick Pick clicks, a human conflict/cancel/undo walkthrough and the competition recording remain **NOT TESTED**. Native API tests are real graphical-host checks, but do not establish those physical interactions.

## 14. Reproduce and readiness gate

Setup/usage and exact local commands are in [README](../README.md) and [recovery](phase-3-recovery.md). Select OpenRouter in a disposable test profile with `TRUEFORGE_AGENT_NAME=forge-coder-openrouter`. Use a working configured account and a new clean pinned Flask clone. The driver performs actual native review/application/save and CLI/help/masked-JSON assertions if generation succeeds.

| Final acceptance criterion | Status |
| --- | --- |
| Commands/activation and actual agent integration | PASS, physical clicks NOT TESTED |
| Retrieval and explicit budgeting | PASS |
| Deterministic safe drafts, staging, hunks, apply/undo/cancel/conflicts | PASS |
| Existing regressions and actual Task A | PASS |
| Successful generic real multi-file workflow | PASS before final refinements; final live repeat blocked |
| Real autonomous official Task B and post-change CLI/help/JSON | FAIL / NOT TESTED |
| Genuine history, full reports and honest checkpoint | PASS as documented |

**Overall: FAIL / PHASE 3 INCOMPLETE.** Do not label the checkpoint competition acceptance or a completed phase.

## 15. Remaining work and delivery

After provider/account capacity becomes available, verify the final retained-draft protocol live, complete Task B without named files, explicitly review/apply/save it, and record passing CLI tests/help/masked JSON and actual Git diff. Then finish the manual GUI walkthrough and only then create a completion commit. No Phase 4 implementation, merge, push, publication or deployment occurred. Git delivery is a clearly labelled local recovery checkpoint; exact final status is in the recovery report and handoff.

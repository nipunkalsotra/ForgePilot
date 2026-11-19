# Final engineering acceptance — 19 November 2026

## 1. Executive verdict

**CONDITIONAL for competition live-repeat readiness.** Deterministic engineering
results and genuine inference are separate gates. This report never awards a judge
score. The 75 technical rubric points describe coverage opportunities; the 25
presentation points remain unearned until the real video/PDF exist.

The implementation adds autonomous task accounting/policies, adaptive retrieval,
local provider pacing, bounded compaction metadata, parse-only draft checks and a
compact panel usage display. Candidate execution remains explicitly unsupported.
Physical walkthrough, recording, PDF, public-link checks and portal submission
were not performed.

## 2. Starting repository and CI state

Started clean on `feat/phase-3-autonomous-agent`, local HEAD
`9c8df0e0321d09a128587409e5ac59c8191a2ec6`. There were no uncommitted user edits.
PR #1 was open against unchanged `main`. Initial local-head Actions run
[44550944737](https://github.com/nipunkalsotra/ForgePilot/actions/runs/44550944737)
failed: Node 24 had 107/115 passing and eight sandbox-dependent failures; Node 22
was cancelled. Fetch found four already published commits ending at the required
`8716e3f7aa3ae05ca95216e5e3414e0b5f78cdb9`. The current branch fast-forwarded,
preserving those fixes and the original routing guide. That remote head's
[run 44555981916](https://github.com/nipunkalsotra/ForgePilot/actions/runs/44555981916)
was successful. No branch was created, history rewritten or PR merged.

The remote fixes provision real Bubblewrap/system runtimes, load Ubuntu's scoped
AppArmor profile without globally disabling user-namespace protection, use full
runtime mounts in the smoke probe, and resolve only trusted Arch/Ubuntu npm CLI
paths. They are retained, not attributed to the new token implementation.
[Starting-state evidence](evidence/final-engineering/starting-state.json).
Original Phase 3/4/5 and panel reports are preserved as dated evidence. The ignored
artifact tree was copied to `/tmp/forgepilot-before-final-artifacts` before drivers
could replace generated outputs; original Task B tracked artifacts are unchanged.

## 3. Token manager

`src/budget.ts` implements `TokenBudgetManager`. Autonomous requests share one
parent manager across the explicitly authorized one-time fallback. Each new user
request creates a new manager. Private IPC supplies configuration and bounded
prompt/spend/tool-count seeds to the companion. Companion policy gates precede
MCP operations; the parent observes SDK calls/results and reports panel state.
Their two views are never summed. Existing 10–600-second turn deadlines remain.
This adds no model-provider client and no independent inference loop.

## 4. Actual, estimated, configured and unknown

SDK 0.185.0 `TurnMetrics` explicitly defines a **billable aggregate for this turn
so far**, including total input/output/cache read/cache write/reasoning/total.
Snapshots replace the same session/turn entry; they are not added as deltas.
Independent turns aggregate. Cache and reasoning counts are separate dimensions,
never added again to total. Zero is actual zero. Missing fields stay unknown;
negative, fractional, nonfinite, overflowing or decreasing counts are rejected or
flagged. Overflow never becomes an invented saturated provider count. Partial
actual totals are labelled partial/unknown. Session metrics expose cost/duration/
turn count, not account balance or request-level token timing.

Observed tool-call IDs and response IDs deduplicate counting independently.
Reported total remains distinct from UTF-8 bytes/3 estimates, streamed text,
response bytes, retrieval estimates, elapsed time and configured limits. Estimated
spend accounts for repeated conversation input at response boundaries. Internal
prompts, schemas, final in-flight output, tokenizer differences and provider
billing details remain unknown. Estimates can differ between parent/companion;
they are not exact live usage. No real before/after provider-token savings or
first-proposal success percentage is claimed.

## 5. Budget policies and settings

Machine/User setting `forgepilot.tokenBudget` is strict, bounded and rejects
unknown fields. **Off** preserves prior behavior and is the default. **Advisory**
warns without hard enforcement. **Conservative**, recommended, reduces retrieval
and bounds repeated discovery/tool work. **Strict** also refuses nonessential work
and new turns once the configured estimated/reported task target is exhausted.
Fallback cannot reset spend or tool counts. Provider failures and local policy
stops remain different failure categories; local budget stops cannot trigger
fallback. A model call already running in TrueForge cannot be precisely capped.

The task target is 2,000–10,000,000 tokens; observed MCP work is bounded to 10–500
calls, 1–20 consecutive unsuccessful validations and 1–10 identical searches.
Inspection/implementation use available budget; initial discovery contracts as
remaining budget decreases, and a 70% warning identifies pressure on correction,
validation and completion reserves. These are adaptive recommendations, not fixed
phase quotas. Checks, approved verification, staging, cancellation and cleanup
remain available. Existing native review remains mandatory. Task enforcement is
for autonomous flows; inline/read-only flows retain their existing deadlines.

## 6. Adaptive context and caching

One ranked query discovers implementation/tests/docs; long files have structural
outlines and targeted ranges. A retrieval uses local verified snapshots, with one
fresh authorized hash comparison for each selected file. Changed or unavailable
snapshots are omitted with truncation/omission evidence, not relabelled current.
Range suppression retains at most 128 workspace/path/hash/range keys, no source.
It returns a compact attributed omission only when smaller than the original.
Fresh content changes, root identity changes, new scopes, cancellation and native
compaction invalidate reuse. There is no persistent source cache or cached
inventory that could hide new files. Low budgets select fewer shorter snippets, shorten ranges to 20 lines and
structural outlines to 25 declarations. Legacy full-file reads return a hashed
outline under pressure; the omission is explicit. Changed scan snapshots identify
the precise reason for omission,
preserving full-file hashes. Proposal and approval payloads are never truncated.

## 7. Provider pacing, quota and fallback

An optional exact-model profile configures context window, maximum output, input
TPM, RPM and safety margin. Mismatched model profiles are ignored with a warning;
unknown limits stay unknown. Session max output and compaction thresholds respect
known local profile configuration without changing the saved manifest. Output
cannot equal/exceed a known context window. Off leaves prior settings unchanged.

Pacing uses rolling local response-boundary input/request estimates, plus actual
post-turn input snapshots when available; it takes the greater representation,
not their sum. Supported data cannot supply precise live provider-global usage,
parallel batch counts or activity from other clients. Pacing is cancellable and
has no fixed delay without configured pressure. Deadline/MCP timeouts can still
end a severely constrained request. No private quota API, credential access,
uncontrolled retries, account rotation or router dependency is introduced.
Provider remaining quota is always **UNKNOWN**. Existing explicit one-time
fallback requires a new isolated session and fresh grants/hunk decisions.

## 8. Checkpoints and native compaction

Existing `list_drafts` metadata now explicitly identifies its current scope and
absence of authority. It remains bounded to the existing 12-file/90,000-byte
retention limits, with IDs/hashes/paths and no source bodies. Native TrueForge
compaction still owns conversation memory. Its completion clears range
suppression so evidence can be read again. No large summary is repeatedly injected.
A failed request may retain only bounded path/hash progress plus unconfirmed
remaining work and revoked approval status. No restore API exists. Expired IDs,
staging approval, hunk decisions and command grants cannot be replayed or revive
retired scopes. New sessions must read/hash sources and rebuild drafts independently.

## 9. Single-request autonomy

General protocol requests high-value context, interfaces, a short plan,
independent retained drafts, complete `check_drafts`, corrections within the same
turn and necessary verification before final approved staging. No Flask solution,
implementation filenames or archived patch is injected. Loop limits detect
repeated searches and unsuccessful validation; actual tool results remain the
only evidence of execution. Model prose is never permission or a test result.

## 10. Static preflight and candidate verification

Existing exact hashes/anchors, overlapping edits, variant fields, duplicate paths,
retained IDs and final-batch correlation are preserved. JSON and CommonJS drafts
also receive parse-only syntax checks using strict JSON parsing and `vm.Script` with Node’s CommonJS wrapper, without
executing modules or resolving imports. Known `tsconfig`/`jsconfig` JSONC filenames skip strict JSON parsing; no JSONC
syntax guarantee is claimed. Shebangs and valid CommonJS top-level returns are
covered against Node’s actual syntax checker. Other-language syntax, dependencies and
behavior remain unverified until real tests run. Diagnostics are concise and
correctable; static validity never promises behavioral correctness.

**Disposable candidate execution is UNSUPPORTED.** The current command sandbox
has read-only source mounts, time/output/scratch bounds and network isolation,
but no portable per-process memory/cgroup budget or secure bounded writable-copy
facility. No unrestricted model-writable filesystem, overlay or unsafe shortcut
was added. Commands test saved files, not proposed drafts or unsaved buffers.
Genuine failure-feedback corrections still require fresh staging and hunk review.

## 11. Agent Panel

The existing dedicated `forgepilot.agentView`, 26 commands, streamed text,
context inspector, native review/apply/undo and Stop controls are preserved.
A compact theme-native usage section shows model/task target, observed tools,
ACTUAL counts, ESTIMATED usage/remaining/context, CONFIGURED policy and UNKNOWN
provider quota/limits. It reports reserve/retrieval/pacing/failure states. Renderer
updates use textContent with the existing restrictive CSP. Credential values and
arbitrary checkpoint source/output are absent from usage messages. Renderer tests
and native host tests verify delivery; physical interaction remains untested.

## 12. Security audit

Fixed the observed provider `Cannot connect to API` wording being classified as
SDK-stream failure; it now reports network failure, with a regression case. The
original genuine failed-run artifact is preserved, not relabelled a successful repeat.
Fixed direct reads after Workspace disposal, mutation during descriptor reads,
and authorized-root replacement. Cached content cannot bypass path validation or
fresh hash checks. Hardened policy exhaustion across fallback and request-scope
reset. Expired command requests return denial without consulting/consuming any
new grant. Scope cancellation aborts pacing; compaction clears deduplication.
Both live read/inline drivers now use isolated snapshots rather than temporarily
modifying the production saved-agent manifest.

Existing safeguards remain: loopback/auth/Host/Origin checks, sensitive-path and
link rejection, source/call/approval correlation, one-time private terminal grants,
real Bubblewrap namespaces/capability dropping, sanitized bounded streams,
accepted-only application, conflict checks and guarded undo. No exercised known
Critical/High defect remains. This is not proof against hostile kernels, same-user
processes, unknown secrets printed by approved repository code, mount races,
resource exhaustion or arbitrary cross-platform behavior. Terminal commands remain
Linux-only and refuse if isolation/system runtimes are unavailable.

## 13. Deterministic regression matrix

Node 22.23.5 and 24.22.3: **140/140 each**, zero failures, zero skips; strict build
and ESLint pass. Original 115 cases are preserved; 25 added cases cover accounting,
zero/missing/malformed/cumulative metrics, overflow, strict/advisory/off/conservative
policy, limits/model mismatch, pacing cancellation, fallback spend, secure range
reuse, changed files/root authorization, compaction reset, checkpoints, parse-only
preflight, real SDK refusal before over-budget inference, and actual renderer labels.
Existing suites exercise terminal approval/denial/replay, actual exit/timeout/
descendants/network/read-only isolation, fallback, cancellation, hunk review and
undo. See retained Node logs and native-host evidence in the evidence directory.

`npm ci` ran on both runtimes. Required commands, package identity, native installed
host and the final live-gate status are recorded in `verification.json` after the
last check. `npm audit --json` reports zero known vulnerabilities. Initial sandbox
network/process restrictions required approved reruns; failed restricted runs are
not counted as successful regressions. No test was disabled to obtain green CI.

## 14. Comparable token-efficiency benchmark

`npm run benchmark:context` compares the retained `9c8df0e` retrieval algorithm
with the optimized engine using identical generated repositories, natural-language
tasks and five operations each: context, outline, and three identical 40-line range
requests. Both use the same current secure Workspace layer. Each sample starts
fresh; three runs report median latency. Fixtures cover small/large Python,
nested mixed implementation/tests/docs, repeated identifiers, long files,
irrelevant files and sensitive/symlink/traversal rejection.

| Fixture | Response bytes before → after | Estimated tokens before → after | Relevant files | Secure reads |
| --- | ---: | ---: | --- | --- |
| Small Python | 3,583 → 3,447 | 1,196 → 1,150 | 3/3 → 3/3 | 14 → 14 |
| Large Python | 11,329 → 8,165 | 3,778 → 2,724 | 3/3 → 3/3 | 330 → 330 |
| Nested mixed | 11,633 → 8,469 | 3,881 → 2,825 | 3/3 → 3/3 | 100 → 100 |

Measured byte reductions: **3.80%, 27.93%, 27.20%** for this repeated-range workload.
Tool calls/context packages remain 5/1; two redundant source payloads are suppressed.
Secure reads remain unchanged to verify current hashes. The shorter-range workload
is separately retained. Latency is informational and platform-sensitive, not an
asserted speedup. These are estimated transport-token reductions, not measured
provider usage, model completion time, valid-draft rate or generic savings.
All nine policy checks per variant pass. Stale-source tests are separate.
[Raw benchmark](evidence/final-engineering/context-benchmark.json).

## 15. Genuine TrueForge gates

Runtime 0.185.1 was restarted from the cached local installation with the existing
database/loopback allowlist. SDK remains 0.185.0. Saved-agent hashes are recorded
before/after, with no provider/payment/quota changes. Real health/live results and
session IDs are recorded in the final evidence; deterministic SDK fixtures never
substitute for inference. Historical genuine three-file, panel/terminal approval,
failed-test correction and fallback evidence remains in the dated reports.

The sole fresh health request, session `01m7tbt27ddh9yq4282rhcs2yx`, turn
`01m7tbt2819533ttyase48rm6z`, used Gemini and failed before streaming/tool
execution. Its persisted error is `[Model Error] Cannot connect to API:`; actual
reported input/output/total were zero. Session creation, cancellation, connector
cleanup and unchanged source hashes passed. This is a **network blocker**, not
verified quota exhaustion. No second provider/inference attempt followed.
[Unmodified live result](evidence/final-engineering/live-read.json) and
[retained category evidence](evidence/final-engineering/live-blocker.json).
The final classification change is deterministically verified; there is no fresh
provider repeat on that final bundle. `npm run test:editing:live`, a fresh genuine
three-file/terminal sequence and official Task B were **NOT RUN** after this gate,
in accordance with the stop-on-provider-failure instruction. They remain blocked,
not passing by historical substitution.

## 16. New official single-request Task B

No fresh full Task B attempt was made because the prerequisite health gate failed.
No new Task B acceptance is claimed. A fresh full attempt is permitted only after
provider health and preceding genuine gates pass. An external failure blocks later
inference rather than triggering repeated probes. The final outcome/blocker is
recorded below and in verification evidence. Historical six-batch/22-hunk success
remains unchanged and is explicitly multi-turn, not a single-request PASS.

## 17. Flask offline replay

A fresh local checkout at `22d924701a6ae2e4cd01e9a15bbaf3946094af65` reconstructed
only the archived original patch, verified its hashes and passed 59 CLI tests,
113 combined CLI/helpers/config tests, help discovery, parseable masked JSON,
ordinary values and unchanged live app configuration. This made no model request.
Patch SHA-256 remains `e4b549bc955fb604c9f22169ae90dc0998fb8e55274f70cfafdfb483b919272e`.
[Current replay](evidence/final-engineering/flask-replay.json).

## 18. VSIX identity and installation

Package/source/installed bundle and media hashes, 26/26 command registrations,
view contribution and third-party notices are checked in the current package and
native host evidence. Final VSIX SHA-256: `0e9e460c905c8b4d2851e4bf407caea69ea66750f710402aaaf849e9b82128a9`.
Installation uses `/opt/visual-studio-code/bin/code`, not
the raw Electron executable used to launch test hosts. An old installed extension
cannot satisfy the current bundle/media identity assertions. A normal-window
physical reload remains an operator action. No Marketplace publication occurred.

## 19. Node 22/24 reproducibility

Supported Node runtimes pass the same strict commands and real Bubblewrap tests;
there are no Linux sandbox skips. System executable layout is Arch/Ubuntu aware;
Windows/macOS command execution remains unsupported. Clean-source archive
verification, dependency audit, license notices and credential/link checks are
recorded in the final evidence. No new runtime dependency was added. A fresh archive of `7703287` passed explicitly versioned Node 24
`npm ci` and all 140 checks/tests, with identical runtime bundle/media/notice bytes.
The first archive exposed omitted renderer assets (139/140); they were committed
and the complete clean gate repeated successfully.

## 20. Official evidence matrix

Read the retained original official PDF directly; SHA-256
`5feeee151edc6bf098743e6eaf5e87b8996adc7bc13abbe1fc8409074d6ddb49`.
[Official statement](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf).
It specifies the following weights/anchors, not an unconditional self-awarded score.

| Criterion | Required highest anchor / implementation | Exact deterministic evidence | Genuine evidence / limits | Confidence / engineering coverage |
| --- | --- | --- | --- | --- |
| A1 — 10 | Inline native diff, per-hunk accept/reject | `patch`, `approval`, editing host | Phase 2/5 genuine staging/mixed decisions; fresh status below; physical proof pending | High / functionality covered |
| A2 — 10 | Discover and edit ≥3 files without filenames in Task B | `context`, `drafts`, `batch`, autonomous host | Historical genuine generic three-file discovery and six-batch official acceptance; no new single-request claim | Conditional / implemented, official fresh-repeat risk |
| A3 — 10 | Immediate cancellation, consistent workspace | `timeout`, `resilience`, terminal approval, panel host | Historical genuine streaming/approval cancellation; final repeat status below | High deterministic / provider repeat conditional |
| B1 — 15 | Automatic budgeted retrieval, files/reasons visible in Task B | `context`, `resources`, benchmark | Actual historical Task B retrieval and inspector; new efficiency is deterministic | High / strategy and size budget covered; video pending |
| B2 — 10 | Per-hunk review and working undo on screen | `patch`, `batch`, coordinator/native hosts | Historical genuine accepted-only apply/guarded undo; final native host status below | High / functionality covered; on-screen proof pending |
| B3 — 10 | Automatic second configured model after Task C, unchanged source | `failure`, `resilience`, `terminal-approval` | Genuine historical failure→Gemini fallback, fresh scopes/approvals; capacity external | High deterministic / fresh live conditional |
| B4 — 10 | SDK/MCP/approval plus meaningful context feature visible/explained | `bridge`, `mcp`, `approval`, `drafts`, resource wire | Genuine sessions/tools; eager/deferred loading and historical native compaction; current checkpoints support that harness | High / integrated; session display and write-up pending |
| C1 — 10 | ≤4-min real video, A/B/C in order with verification | No video produced | Physical walkthrough/recording outstanding | Not assessed / no points awarded |
| C2 — 15 | 1–3-page PDF, eight ordered headings, timestamp scorecard/limits | Technical docs only | Final PDF/timestamps outstanding | Not assessed / no points awarded |

Engineering A1–B4 has coverage across all seven categories, with explicit live
repeat limitations. No guaranteed 75/75 or 100/100 is asserted. The eligibility
architecture uses TrueForge exclusively for inference/orchestration and exposes
read/search/propose/run-command as MCP. Actual public artifacts, video/session
proof and judge assessment remain separate. Deadline in the statement is
20 November 2026, 23:59 IST; repository/video/PDF links must be public before it.

## 21. Remaining technical limits

Provider capacity and single-request Task B reliability remain external/unverified
unless explicitly passed by a fresh run. Candidate execution is unsupported.
Python/TS/import behavior is not guaranteed by static checks. Budgets are local
estimated work targets, not exact provider billing/context/RPM controls. Remaining
quota is unknown. Terminal confinement is Linux-only; exposed system pytest and
network-free dependencies must exist. State is in memory, with no automatic
cross-session continuation. Physical focus/accessibility/normal-window reload and
VS Code's minimum-version GUI are not claimed tested. See dated panel report for
broader kernel/process/mount/unknown-secret limitations.

## 22. Git delivery

All changes stay on the existing feature branch. Main, historical Task B evidence,
provider credentials, account settings and saved-agent manifests remain unchanged.
Implementation commits are `e14c573`, `e8a5213`, and `7703287` (CommonJS/JSONC
compatibility); `e8a5213` includes the
renderer assets caught by clean-source verification. Documentation and
existing-branch delivery are recorded in final evidence;
PR #1 stays open. No repository visibility or extension publication action is
performed. The first delivery at `53b16b7` passed both GitHub Actions jobs in
[run 44580215765](https://github.com/nipunkalsotra/ForgePilot/actions/runs/44580215765).
The final compatibility/receipt delivery is independently checked; its result is
recorded in verification evidence and the delivery response.

## 23. Final engineering gate

Final exact commands/results, package SHA-256, manifest preservation, live blocker,
installed identity, CI and delivery state are recorded in
[evidence/final-engineering/verification.json](evidence/final-engineering/verification.json).
The Phase 6 handoff is updated for the actual panel/terminal/budget implementation.
Physical demo, recording, final PDF, operator public-link checks and submission
remain distinct. No synthetic screenshot/video or judge score was fabricated.

<!-- Updated for token-aware engineering; historical Phase 5 evidence remains unchanged. -->
# Phase 6 handoff — preparation only

Phase 6 has **not** been executed. The current engineering verdict is **CONDITIONAL**:
deterministic Node 22/24 and installed-host gates pass, but the sole fresh health
request failed with a provider network error. Restore legitimate connectivity and
pass the bounded live gates before attempting a new Task B or recording. See
[final engineering acceptance](final-engineering-acceptance.md). No video, submission PDF, portal upload,
publication, commit or push was created during Phase 5. Technical results and
limitations are in [Phase 5 verification](phase-5-final-verification.md).

## Verified official requirements

Source: [TrueFoundry Forge-a-thon official statement](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf),
downloaded and read during Phase 5; PDF SHA-256
`5feeee151edc6bf098743e6eaf5e87b8996adc7bc13abbe1fc8409074d6ddb49`.
Submission deadline: **20 November 2026, 23:59 IST**. Three public links must be
submitted through the Techfest Competition Portal: demo video, write-up PDF,
and open-source GitHub repository. Registration/Team ID and the live portal's
fields remain for the operator to confirm.

The video must be at most **four minutes**, show the editor, and demonstrate
**Tasks A, B, C in that order**, each with its on-screen verification. Briefly
show the TrueForge Task B session. The statement permits cutting model waiting
time but also says not to cut between instruction and diff appearance. Preserve
each instruction-to-diff segment continuously; confirm the intended rule with
organizers before using more aggressive cuts. The current multi-turn Task B
history is not evidence of a fresh clean single-turn demonstration.

The write-up is **1–3 PDF pages**, with these headings in order:

1. Team (members, institution/employer, GitHub handles).
2. Starting point (from scratch; repository baseline `e77080b`).
3. Architecture on TrueForge.
4. How context is selected (retrieval strategy and budget).
5. Model setup (every model used, where it ran, approximate cost, switching).
6. Scorecard (one row per official judging criterion, real video timestamp and claim).
7. Tools used (include Codex assistance).
8. Known limitations and what you would do with another month.

Official scorecard rows: A1 Inline edit (10), A2 Agent mode (10), A3 Streaming
and cancellation (10), B1 Context assembly (15), B2 Diff safety (10), B3 Resilience (10),
B4 TrueForge integration depth (10), C1 Video (10), C2 Write-up (15).
Do not invent timestamps, scores or monetary costs. Recorded models were
`google-gemini/gemini-3-1-flash-lite` (original medium reasoning and temporary
high-reasoning copies) and `openrouter/nemotron-3-ultra-free` (underlying
`nvidia/nemotron-3-ultra-550b-a55b:free`, high reasoning), called by local TrueForge
against configured remote providers. The provider reported free-tier limits;
the SDK returned no monetary cost. Verify actual account costs before estimating.

## Before recording

- Complete the physical checklist in Phase 5, including normal-window reload.
- Use the installed VSIX and CLI wrapper from [README](../README.md); keep
  TrueForge 0.185.1 on port 8790 with the documented loopback allowlist.
- Preserve `forge-coder` and `forge-coder-openrouter`. Confirm existing provider
  capacity through the intended task; do not exhaust quotas with repeated probes.
  Fallback requires explicit User settings and a distinct saved agent.
- Use disposable Flask 3.1.3 checkouts pinned to
  `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, with the documented compatible
  venv outside each checkout. Keep a fresh checkout for B and for C so A does
  not contaminate their starting status. Save and show status after each action.
- **Do not apply the archived Task B patch to a fresh autonomous demonstration.**
  It is for offline replay only. A demo generation must come from TrueForge.
- Keep credentials/provider settings out of the recording. Use a dedicated
  synthetic test application outside the checkout for `flask config` output.
- Use the dedicated ForgePilot Agent panel and genuine approved `run_command` MCP
  tool. Verify the installed package identity in the current
  [engineering acceptance](final-engineering-acceptance.md). Candidate execution is
  unsupported: commands see saved disk contents. Keep that distinction visible.

## Exact recording sequence

Suggested time allocation, not actual video timestamps: A 0:00–0:45,
B 0:45–3:00, C 3:00–3:45, conclusion/artifact references 3:45–4:00.
Never replace an unsuccessful live task with a prepared solution.

1. **Task A — native selection and review.** Open `src/flask/helpers.py`, select
   `get_debug_flag`, run **ForgePilot: Edit Selection** and give exactly:
   “Treat the values 'off' and 'n' as false as well, case-insensitively, and update
   the docstring to list every value that is treated as false.” Show streaming,
   **Allow Staging**, native diffs and explicit hunk decisions, then
   **Apply Accepted Hunks** and save. Run
   `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`
   using this checkout's venv/PYTHONPATH and show `False`. Show guarded undo/save.
2. **Task B — discovery and three-file review.** Open its new clean pinned
   checkout. Run **ForgePilot: Autonomous Agent**, with no file references:
   “Add a new built-in CLI command flask config that prints the loaded
   application's configuration as JSON, masking the values of any key containing
   SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be
   covered by a test, and be documented alongside the other built-in commands.”
   Show Output and **Inspect Repository Context**, the genuine session in
   TrueForge, staging permission, **ForgePilot Agent Changes**, native file/hunk
   diffs, **Review Batch Hunks**, explicit decisions, **Apply Accepted Batch
   Hunks**, and save. Show `git diff --stat`, `python -m pytest tests/test_cli.py -q`,
   `python -m flask --help`, and `python -m flask --app /absolute/path/to/demo_app.py config`
   with synthetic sensitive values masked and ordinary values visible.
   Feedback/corrections must be disclosed with fresh approvals; no single-turn
   success claim is supported by the retained acceptance chain.
3. **Task C — safe failure and optional fallback.** In its clean disposable
   checkout, repeat Task A with an isolated test-only invalid key or unreachable
   endpoint. Never alter real providers. Show a clear sanitized error, responsive
   editor and unchanged `git status --porcelain`. If showing fallback, use an
   explicitly configured secondary, show fresh staging/hunk decisions and stop
   before application to keep status unchanged. Prior programmatic proof is in
   `docs/evidence/phase-5/retained-task-c.json`; creating test-only failure
   providers remains a deliberate operator action. The harness
   `scripts/verify-taskc.ts` provisions/deletes only disposable configuration,
   but makes genuine provider requests and should not be rerun just for footage.
4. Show cancellation and undo in the above workflow if legible within four
   minutes. Use **Open Verification Terminal** for developer-run verification.

Showcase three things: TrueForge-owned discovery/context; native approval-driven
multi-file edits with undo; bounded failure/cancellation with explicit fallback.

## Retained evidence to display and link

- Task B first generation: `01m7se73xvn31zsj2sdwh36wyc`; final passing correction:
  `01m7sgcvvb0ysapthbdbnvd123`. Show the final session plus the six-batch chain,
  not only a success summary. [Acceptance and replay package](evidence/task-b/README.md).
- Genuine fallback: `01m7sk6m8rtm0qqyh2t1fkq3e9` →
  `01m7sk6mrhhgtmc8z9fn6x7r8w`. Fresh Phase 5 live read/inline/installed-command
  sessions are recorded in [verification evidence](evidence/phase-5/).
- Historical Phase 5 outputs: 83 ForgePilot tests on Node 22/24, native installed-host
  assertions, 59 Flask CLI and 113 combined replay tests. Distinguish tests,
  offline reconstruction and genuine inference on screen/in captions.
- Technical references: [README](../README.md), [architecture](architecture.md),
  [Phase 3 acceptance](phase-3-final-acceptance.md), [Phase 4](phase-4-verification.md),
  and [Phase 5](phase-5-final-verification.md).

## Human delivery actions

Confirm registration and team details; perform/record the walkthrough; produce
the actual PDF and scorecard; verify all public links signed out; submit all three
links in the portal before the deadline. Current engineering delivery is recorded in [final acceptance](final-engineering-acceptance.md);
operator-controlled repository visibility and signed-out link checks remain.
 PR #1 must stay open and `main`
must remain unchanged. The new local documentation links will not work remotely
until that authorized delivery. Marketplace publication is out of official scope.
No further repository investigation should be needed before these operator steps.

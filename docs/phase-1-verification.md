# Phase 1 verification report

Date: **17 November 2026**. Repository: `nipunkalsotra/ForgePilot`. Starting HEAD: `e77080b`. Work is uncommitted for manual review, as requested; nothing was pushed or published.

## Acceptance checks

| Acceptance check | Status | Evidence |
| --- | --- | --- |
| Dependencies install | **PASS** | Final `npm ci` completed; 228 packages audited, zero reported vulnerabilities. Lockfile included. |
| TypeScript compilation | **PASS** | `npm run build`: strict `tsc --noEmit`, followed by bundled extension, child, and host test builds. |
| Lint | **PASS** | `npm run lint`: ESLint 10.15.0, zero warnings. |
| Unit / automated integration tests | **PASS** | `npm test`: **17 passed, zero failed/skipped**. Includes real MCP HTTP calls, authentication/Origin/Host checks, path/symlink/hardlink policy, a concurrent ancestor symlink replacement test, read/search budgets, event rendering, process exit and IPC disconnect, and SDK contract cancellation/rollback. |
| Graphical Extension Development Host | **PASS** | Installed VS Code 1.117.0 launched an isolated GUI host, loaded and activated ForgePilot, registered all commands, and exited with code 0. |
| Real saved-agent session creation | **PASS** | SDK called `sessions.create({ agent: { name: 'forge-coder' } })`; session binding is a saved-agent reference, not an inline substitute. |
| Real response streaming | **PASS** | Final SDK live run received **3 actual assistant text delta events**, rendered incrementally. Turn status `done`. |
| Agent invokes our MCP tools | **PASS** | Actual companion logs record successful `list_files` and `read_file`. Agent returned the unpredictable fixture marker, which was not supplied in its prompt. |
| TrueForge history records actual tool calls | **PASS** | `sessions.listEvents` returned persisted `model.message.toolCalls` identifying our MCP server and correlated `tool.response` records containing the actual marker. |
| Workspace unchanged by agent/tools | **PASS** | SHA-256 snapshots before/after are identical for every live fixture file, including the hidden `.env` test fixture. GUI test also verifies fixture contents and directory entries are unchanged. Repository implementation changes listed below are intentional development work. |
| Entire chain from VS Code commands | **PASS** | GUI test drives production `forgepilot.start`, `forgepilot.ask`, and `forgepilot.stop`; verifies real MCP read history and the random workspace marker; verifies registry cleanup. |
| Companion cleanup | **PASS** | Real child exit and closed socket verified; explicit stop and parent IPC loss tested. Live temporary connector removed and saved-agent attachment detached. History preserved. |

These are separate kinds of evidence. `tests/bridge.test.ts` uses an explicitly labelled HTTP protocol fixture for SDK failure/cancellation contracts; it does **not** establish live model execution. `tests/mcp.test.ts` exercises real MCP SDK transports and filesystem operations. `npm run test:live` and the opt-in GUI live test use the genuine local TrueForge server and configured provider, with no simulated model or tool fallback.

## Live evidence

- Final SDK live session: **`01m7mn5bv0cm9k2nteq0aknr38`**.
- Final graphical full-chain session: **`01m7mn7ha4mz50zwpdw8z5v649`**; real MCP read history, unchanged fixture, connector cleanup, and host exit code 0 were verified through extension commands. Earlier graphical session: `01m7mmpth3trgavbtz9y8mvz4c`.
- Agent: **`forge-coder`**, immutable saved-agent ID **`01m7mk1a79ev6z2wzfq1kg094c`**.
- Model: **`google-gemini/gemini-3-1-flash-lite`** (Gemini 3.1 Flash Lite), using the user's existing Google Gemini provider configuration inside local TrueForge. Cost was not supplied in TrueForge session metrics; no cost estimate is invented.
- Final SDK tool call IDs: `call_8617556296582558056` (`list_files`) and `call_10582654697359315499` (`read_file`). Persisted history was verified by call ID and connector identity.
- Final SDK inspection file SHA-256 before and after: `4ef0eba3c3a1990d6a094f7328bb31537bdb075823aee4a4202bb6a1295c2f18`.
- Hidden fixture `.env` SHA-256 before and after: `9c4108e28170c513dfb5638844bde8a615116b5f7428f205a4cce8d90c4bcc0b`. This contains a synthetic test value, not a real credential, and was not exposed to the model by tools.
- Machine-readable results: ignored local `artifacts/live-verification.json`. The temporary workspace is deleted after checking; TrueForge session history remains available in its UI.

Tested versions: Linux x64; development Node **26.7.0**, npm **11.19.0**, desktop VS Code **1.117.0**; TrueForge **0.185.1**; TrueForge SDK **0.185.0**; MCP SDK **1.32.2**; TypeScript **5.9.3**; Zod **4.6.7**. VS Code API types are pinned to the declared minimum **1.101.0**, whose extension host provides Node 22. The installed TrueForge package's own dependency manifest confirmed SDK 0.185.0.

## Issue diagnosed and resolved

The initial live attempt was blocked by TrueForge's default outbound guard: `Outbound URL blocked for host "127.0.0.1"`. No session/model success was claimed for that attempt. The extension now provides an actionable error, and failed registration rollback tolerates a missing connector.

After confirming there were no running or paused sessions, the idle local TrueForge process was gracefully restarted with its original executable, environment, working directory, and saved data, adding **only `127.0.0.1`** to `OUTBOUND_URL_ALLOWED_HOSTS`. The outbound guard remains enabled. The replacement runtime PID was **86637**, with runtime output at `/tmp/forgepilot-trueforge-runtime.log`. No provider credential was printed or written into this repository. The saved agent and existing sessions were retained.

This allowlist is a setting on the running TrueForge process. For future starts, use the README command; no persistent user shell configuration was changed. The TrueForge runtime remains running intentionally. ForgePilot companion processes are stopped after the tests.

## Reproduce

```sh
npm ci
npm run check
# Separate terminal, if TrueForge is not already running with the loopback allowlist:
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.185.1 --port 8790
# TrueForge Settings → Models: configure provider; preserve existing forge-coder.
npm run setup:agent
npm run test:live
FORGEPILOT_EXTENSION_LIVE=1 VSCODE_EXECUTABLE_PATH=/opt/visual-studio-code/code npm run test:extension
```

For manual editor verification, press F5 in this repository, open/trust a local test workspace, run **ForgePilot: Start Read-Only Session** and **ForgePilot: Ask Agent**, and request `list_files` followed by `read_file`. Watch the ForgePilot Output panel, inspect the named session in TrueForge, and run **ForgePilot: Stop Session and MCP Server**. See README for configuration, platform-specific executable paths, multi-root authorization, and stale-connector cleanup.

## Remaining blockers and unverified behavior

**No remaining blocker for the tested Linux Phase 1 path.** Programmatic registration and attachment work on the installed server, so manual connector registration is unnecessary.

| Additional check or limitation | Status / scope |
| --- | --- |
| macOS and Windows filesystem/process behavior | **NOT TESTED**; Linux-specific descriptor containment is additionally enforced on Linux. |
| Node 22 / 24 CI matrix | **NOT TESTED locally**; workflow provided. Final local checks ran on Node 26.7.0, GUI checks in VS Code's bundled runtime. |
| Model failure and cancellation during a genuine model turn | **NOT TESTED live**; failure/paused events and SDK cancellation/overlapping turns are covered by automated unit/HTTP-contract tests. |
| OIDC authentication against a configured server | **NOT TESTED**; optional token is supported through SecretStorage/environment. Tested server uses local default identity. |
| Multiple active instances sharing one saved agent | Unsupported; other attachments are rejected. The API has no conditional manifest updates, so concurrent clients must be avoided. |
| Hard-killed parent while registry cleanup is impossible | Companion IPC exit tested; stale TrueForge connector metadata can require manual removal. Closed local endpoint revokes file access. |
| Credential embedded in an ordinary permitted source file | Filename policy cannot classify arbitrary file contents. Hidden/credential paths are denied; choose a workspace appropriate for the configured provider. |
| Inline editing, proposed writes, diff review, command execution | Intentionally outside Phase 1; absent. No Phase 2 work performed. |

## Exact repository file changes

Modified existing files (**2**):

```text
.gitignore
README.md
```

Added files (**30**):

```text
.github/workflows/check.yml
.vscode/launch.json
.vscode/tasks.json
.vscodeignore
config/forge-coder.agent.json
config/trueforge.env.example
docs/phase-1-verification.md
eslint.config.mjs
package-lock.json
package.json
scripts/build.mjs
scripts/setup-agent.ts
scripts/verify-extension.ts
scripts/verify-live.ts
src/bridge.ts
src/companion.ts
src/config.ts
src/events.ts
src/extension.ts
src/log.ts
src/mcp/child.ts
src/mcp/server.ts
src/workspace.ts
tests/bridge.test.ts
tests/config.test.ts
tests/events.test.ts
tests/extension-host.ts
tests/mcp.test.ts
tests/workspace.test.ts
tsconfig.json
```

`LICENSE` is unchanged. Generated `dist/`, `node_modules/`, `.vscode-test/`, and `artifacts/` are ignored. No nested repository, commit, push, package publication, or provider credential was added.

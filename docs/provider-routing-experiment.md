# Optional multi-provider routing experiment (9Router / OmniRoute)

**Status: NOT LIVE-TESTED with TrueForge.** This is an opt-in evaluation guide, not an installed/working provider, a new Task B PASS, an unlimited-token entitlement, or a change to ForgePilot's model execution architecture.

The project's existing `forge-coder` and `forge-coder-openrouter` saved agents, TrueForge credentials, Phase 3/4 acceptance evidence and PR #1 remain untouched.

## Goal and limits

OmniRoute and 9Router offer local OpenAI-compatible gateways that route eligible inference requests through several independently configured provider accounts and can fail over on quota/provider errors. They **do not manufacture free tokens**, bypass providers' request-per-day or tokens-per-minute limits, or guarantee successful tool calls. Claims of a very large aggregate monthly token pool combine distinct plans, accounts and models, not one uninterrupted context or a free quota held by the router.

An upstream switch *within* an ongoing TrueForge turn may break tool-call IDs, format, stream continuity, reasoning syntax, context size or approval correlation. Never classify a successful plain chat completion as sufficient compatibility evidence. Preserve the full turn in TrueForge; the router is only an inference transport.

Provider selection must obey each provider's current terms and rate limits. Do not automatically enable paid providers, trial credits that require billing, unauthorized shared accounts or credential/account rotation to evade limits.

## Reference projects and security

- OmniRoute: https://github.com/cheaper-inference/OmniRoute
- OmniRoute setup: https://github.com/cheaper-inference/OmniRoute/wiki/Setup-Guide
- OmniRoute auto routing: https://github.com/cheaper-inference/OmniRoute/wiki/user-guide
- 9Router: https://github.com/decolua/9router
- Prior 9Router security advisories include SSRF and authentication/open-proxy flaws: https://github.com/decolua/9router/security/advisories

**Prefer a locally hosted, loopback-only instance.** Do not make the dashboard/API publicly reachable, expose the provider credential store to a hosting platform unnecessarily, or deploy with an unauthenticated `/v1` endpoint. Review a current upstream security release before installation, keep credentials outside Git, and disable/redact prompt and response logging according to the router's capabilities. The router and its upstream providers can see task prompts, relevant repository context and tool-call content. Never send proprietary or sensitive code to untrusted free endpoints.

## Setup (performed manually on the developer's machine)

1. Back up the existing TrueForge configuration/database; do not overwrite its saved agents or provider keys.
2. Install a reviewed official release of **one** router using its upstream instructions. For OmniRoute the documented local dashboard is `http://127.0.0.1:20128`, with OpenAI-compatible API `http://127.0.0.1:20128/v1`. Bind to `127.0.0.1` only. Do not expose the port using a public tunnel or default `0.0.0.0` Docker mapping. Use `-p 127.0.0.1:20128:20128` if using Docker's published port.
3. In the router dashboard, connect only **eligible, authorized free** providers for which you have genuine capacity. Inspect individual request limits, token rates, tool-calling/streaming support, context windows and prompt-data policies. Restrict automatic candidates to compatible, unpaid providers.
4. In OmniRoute **Endpoints**, create a local endpoint credential. Test `GET /v1/models` using a Bearer token from a protected environment; do not put the token in this repository, command arguments shown in screenshots, logs, or a provider name.
5. In TrueForge Settings → Models, create a **new** custom OpenAI-compatible provider:
   - Name: `omniroute` (or another lowercase identifier)
   - Base URI: `http://127.0.0.1:20128/v1`
   - API key: the router's endpoint key **entered only in the TrueForge UI**
   - Model ID: `auto/coding` **only if the router's current model catalog advertises it**; otherwise use a verified fixed compatible model/route.
   - Model name: `omniroute-coding` (TrueForge's lowercase-hyphen name, distinct from upstream model ID).
   - Context length and max output tokens: set conservative values actually supported across all *eligible* upstream candidates. Do **not** copy a 1,000,000-token context claim from an unrelated model. Reasoning effort: leave disabled unless the routed provider mapping was tested with that setting.
6. Save a **new** TrueForge agent named `forge-coder-omniroute` pointing at the exact registered model ID returned by TrueForge. Copy the existing safe agent instructions/policies; leave permanent MCP servers and skills empty. ForgePilot must attach its own temporary authenticated MCP connector per session.
7. Select `forge-coder-omniroute` through the existing machine-scoped VS Code setting `forgepilot.agentName`, without modifying the existing Gemini/OpenRouter agents. Do not configure automatic fallback until its behavior is verified. Leave `forgepilot.fallbackEnabled` off initially.

**Compatibility note:** TrueForge's handling of `auto/coding`, streamed tool-call arguments, reasoning fields, or a localhost custom-provider Base URI has **not** been confirmed in this project. If the UI rejects the provider/model or an SDK tool call fails, record the exact sanitized error and stop. Do not work around it with direct model requests inside the extension.

## Mandatory acceptance gates, in order

| Gate | What proves it | When to stop |
| --- | --- | --- |
| A — Router connectivity | Authenticated `/v1/models` lists the intended route | Wrong endpoint/auth; no compatible candidates |
| B — TrueForge compatibility | TrueForge saved agent streams a response via the route; real model/session IDs recorded | Unsupported provider/model/reasoning/stream |
| C — Genuine tool use | Existing `scripts/verify-provider-health.ts`, with `TRUEFORGE_AGENT_NAME=forge-coder-omniroute`, passes read-only MCP discovery/read/cleanup | Tool arguments, stream events or connector handling fail |
| D — Genuine approval | Small disposable repository, `run_command` denial and approval, no model-generated authority, exact one-time grant | Tool IDs or human-approval correlation fail |
| E — Three-file lifecycle | Real TrueForge agent independently discovers source/test/docs, stages a validated proposal, and completes native hunk review/apply/undo | Model repeatedly emits invalid drafts |
| F — Official single-pass Task B | **Fresh clean** pinned Flask 3.1.3 checkout; exact high-level task, no implementation-file hints, exactly one continuous original agent task, independently passing CLI tests/help/masked JSON; review approvals permitted | Any manual code patch, preloaded accepted patch, separate corrective task or provider exhaustion makes the claimed single-pass result invalid |

For gate C, the existing health script uses local TrueForge and makes a real model request:

```sh
npm run build
TRUEFORGE_AGENT_NAME=forge-coder-omniroute node --import tsx scripts/verify-provider-health.ts
```

Run only if the route/provider capacity allows. The script writes evidence to an ignored `artifacts/` path; inspect for sensitive content before sharing. For gate F, preserve the earlier multi-turn Task B result separately, never overwrite its provenance, and explicitly label a new result SINGLE PASS only if it actually is. Avoid blind retries.

## Decision

Use one locally hosted router as an **optional inference gateway**, not a new agent loop. Keep both the original TrueForge agents available as known reference configurations. If gates B–E fail, stop and use the already verified provider setup for the competition. If they pass, a single-pass Task B attempt is worth trying, but success remains a model-quality/reliability question, not a quota guarantee.

**Not done by this document:** deploying a router, importing provider keys, changing local TrueForge settings, performing live compatibility checks, running a new single-pass Flask task, physically clicking the VS Code UI, video capture or submission.

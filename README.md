# m365-copilot-proxy

Use Microsoft 365 Copilot as an LLM backend for OpenAI-compatible coding agents like [pi](https://pi.dev/) and [OpenClaw](https://docs.openclaw.ai/). Wraps M365 Copilot's WebSocket/SignalR API in an OpenAI-compatible interface with robust tool-calling support.

> 📖 **Looking for the protocol deep-dive?** See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) for the complete reference on M365 Copilot's undocumented WebSocket API: MSAL PKCE auth, SignalR frames, tones/models, throttling, the "Disengaged" filter, and the Copilot Studio agent trick that enables tool calling. For prompt-engineering and tool compliance strategies, see [docs/prompt-engineering.md](docs/prompt-engineering.md).

---

## ⚡ Quick Start

Get up and running in minutes:

### 1. Clone & Build
```sh
git clone https://github.com/cramt/m365-copilot-proxy
cd m365-copilot-proxy
pnpm install
pnpm build
```

### 2. Configure Credentials
Create `~/.config/opencode-m365/secrets.json`:
```json
{
  "email": "you@company.com",
  "password": "your-password",
  "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
}
```
*`mfaSecret` is your authenticator app's base32 seed (e.g. `JBSWY3DPEHPK3PXP`). See [Getting the TOTP secret](#getting-the-totp-secret) for how to retrieve or generate it.*

> **No TOTP option on your tenant?** (push-only MFA, FIDO2, Okta/Ping/Duo): Skip `secrets.json` and set `export M365_ENABLE_INTERACTIVE_APPROVAL=1` to complete sign-in in a visible browser window once. Tokens refresh silently thereafter. See [Interactive approval fallback](#if-your-tenant-has-no-totp-option).

### 3. Start the Proxy
```sh
pnpm run proxy 4141
# or: m365-proxy 4141
# or: pnpm run dev
```

### 4. Connect Your Agent

#### Option A: [pi](https://pi.dev/)
Add the provider to `~/.pi/agent/models.json`:
```json
{
  "providers": {
    "m365": {
      "baseUrl": "http://localhost:4141/v1",
      "api": "openai-completions",
      "apiKey": "m365",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        { "id": "gpt-5.5-think-deeper", "name": "M365 Copilot (GPT-5.5 Reasoning, recommended)" },
        { "id": "gpt-5.6-think-deeper", "name": "M365 Copilot (GPT-5.6 Reasoning)" },
        { "id": "claude-opus-5.5", "name": "M365 Copilot (Claude Opus 5.5)" }
      ]
    }
  }
}
```
Run `pi` against the proxy (keep tools lean to stay clear of M365's Disengaged filter):
```sh
pi --models "gpt-5.5-think-deeper" -p --tools read,list,edit,write "your task"
```

#### Option B: [OpenClaw](https://docs.openclaw.ai/)
Configure and launch automatically:
```sh
# Configure provider and start proxy in one command:
m365-openclaw-setup --start

# Or configure provider only, then launch proxy manually:
m365-openclaw-setup
m365-proxy 4141
```

#### Option C: Any OpenAI-Compatible Client
Configure your client with:
- **Base URL**: `http://localhost:4141/v1`
- **API Key**: `m365` (or any string)
- **Model**: `gpt-5.5-think-deeper` (recommended for coding/tools) or `gpt-5.6-think-deeper`

---

## 📊 Web Dashboard & Monitoring Endpoints

The proxy includes a zero-dependency real-time web interface and REST observability endpoints:

### Interactive Web Dashboard (`/` or `/dashboard`)
Visit **`http://localhost:4141/`** or **`http://localhost:4141/dashboard`** in your browser. The dashboard runs directly from the proxy binary with zero client-side dependencies:
- **Rate Limit Meters**: Real-time gauges for fresh-session tokens, 10-minute burst turns, and 60-minute sustained volume.
- **Turn Velocity & Wire Pacing**: Visual status of the Priority FIFO Turn Gatekeeper (`paceTurnVelocity`), including in-flight spacing and retry queue depth.
- **Active Sessions**: Inspect currently open conversation sessions, turn counts, active models, and last-activity timestamps.
- **Sliding-Window Quality Metrics**: Tracks clean tool executions, confabulation retries, classified prose deliverables, and upstream content refusals.
- **Real-Time SVG Sparklines**: Visualizes request traffic, turn rate, and throttle events across rolling 1h, 6h, and 24h windows.
- Automatically polls and updates every 2 seconds via `/api/metrics`.

### Diagnostic Endpoints
- **`GET /health`**: Returns `{"status":"ok"}`. Ideal for container readiness/liveness checks and systemd watchdog probes.
- **`GET /api/metrics`** (also accessible at `/metrics` and `/v1/metrics`): Returns the complete `MetricsSnapshot` JSON:
  - Supports query parameter `?range=1h` (default), `?range=6h`, or `?range=24h`.
  - Exposes system rate limiters, active sessions, turn quality counters, bucketed time series, and lifetime totals.
- **`GET /v1/models`**: Standard OpenAI models list with advertised `context_window` (1,000,000 tokens) and `max_output_tokens` (1,000,000 tokens) to prevent agent frameworks from pre-truncating prompts.

---

## 📦 Packages

The repository is organized as a pnpm workspace across four TypeScript/ESM packages:

| Package | Role |
|---|---|
| [`@m365-copilot/core`](packages/core) | Core protocol engine: MSAL PKCE auth, SignalR WebSocket client, Copilot Studio agent provisioning, fenced tool formatting, Dual-Engine SLM turn classifier, and image generation. |
| [`@m365-copilot/proxy-lib`](packages/proxy-lib) | Framework-free Web-standard `createApp()` fetch handler, `SessionPool`, Dual-Horizon Leaky Bucket, Turn Gatekeeper, dashboard HTML/SVG generation, and atomic state persistence. |
| [`@m365-copilot/proxy`](packages/proxy) | Standalone [Nitro](https://nitro.build/) server executable wrapper (`m365-proxy`). File-based routes, startup auth plugin, and production builds. |
| [`@m365-copilot/openclaw-plugin`](packages/openclaw-plugin) | OpenClaw provider generator, interactive setup CLI (`m365-openclaw-setup`), and agent skill integration. |

---

## 🛠️ How It Works & Architecture

M365 Copilot communicates over an internal SignalR WebSocket protocol, not the OpenAI REST schema. `m365-copilot-proxy` bridges the two with specialized translation layers:

### 1. Tool Calling
M365 Copilot does not support native OpenAI-style `tool_calls`. Instead, tools are emulated via a **Markdown-fence format** (legacy bare-JSON schemas were removed after scoring 0/5 on real agentic tasks; see [hypotheses §9](docs/hypotheses.md)):

- **Fenced Templates (`fenced.ts`)**: Tool definitions are injected into the prompt within a `<tools>` block using code-fence examples.
- **Mechanical Shell-Routing**: M365's chat model resists "acting as an autonomous agent" but reflexively emits ```` ```bash ```` blocks when asked for commands. When a shell tool (`bash`, `shell`, `run`, `run_command`, etc.) is present in the toolset, the proxy routes the code block directly to the client's shell tool.
- **Universal Advisor Framing**: Rather than coercing the model with aggressive agent-identity prompts (which trigger model refusals), the proxy frames interaction as an advisor: *"You write the shell commands; I run them and paste the real output back to you..."*.
- **Delta Turn Tool Re-Injection**: On multi-turn conversations (`turn > 0`), the proxy automatically re-injects tool definitions into `formatDeltaMessages`. M365 reasoning models (`DeepLeo`) require continuous tool context; without re-injection, follow-up turns often confabulate that tools are no longer available.
- **Simulation Rejection**: If a model hallucinates assistant-simulated `<tool_response>` tags in its output, the proxy strips them and flushes the session context to force a clean full-history replay on the next turn.
- **Structural Clause NLP (`tools.ts`)**: Uses clause-boundary segmentation (`[Tool Anchor] + [Negation] + [Availability State]`) to intercept subtle refusals, fake file existence claims, truncation surrenders, and shell error deferrals without tripping on filenames with dots (e.g. `test_candidate_claim.py`).
- **Dual-Engine SLM Turn Classifier (`classifier.ts`)**: Distinguishes genuine prose deliverables (such as security audit write-ups or test failure analyses) from tool confabulations using Gemma 4 E2B with Chain-of-Thought reasoning. If `M365_CLASSIFIER_OPENAI_URL` is set, queries the remote endpoint; otherwise runs in-process via `@kessler/gemma` ONNX. Completely bypassed for tool-calling turns (~95% of requests) for 0ms overhead.

### 2. Copilot Studio Agent Mode
On first request with tools, the proxy provisions a dedicated **Copilot Studio agent** with tool-calling system instructions baked into its server-side prompt via the PowerPlatform API:
1. Discovers environment URL via the BAP API (`api.bap.microsoft.com`).
2. Creates a bot using Copilot Studio's `minimalBots` API.
3. Publishes the bot to obtain a `TitleId`.
4. Attaches the agent identifier (`T_{titleId}.{botId}.gpt.default`) via `threadLevelGptId` in WebSocket frames.
5. **Immutable Instruction Hashing**: The bot is named `m365-tool-agent-<sha256(instructions)[:8]>`. Changing instructions creates a fresh bot while leaving previous bots intact, eliminating race conditions across multi-host environments.
6. Caches the resolved agent ID in `~/.config/opencode-m365/agent-id.json`.

### 3. Dual-Horizon Rate Limiting & Resilience
M365 Copilot enforces two separate rate-limiting horizons on paid tenant accounts:

- **Thread-Rate Protection (`PerScenarioThrottled`)**:
  - Microsoft throttles *conversations created per unit time*, not message volume.
  - Exceeding the rate trips an upstream `PerScenarioThrottled` completion frame and arms a 30-minute cooldown (`M365_THROTTLE_COOLDOWN_SEC = 1800`).
  - **Protection**: A local token bucket (`M365_SESSION_BUCKET_CAPACITY = 10`, refilling every 150s) combined with a 15-second stagger queue (`M365_NEW_SESSION_SPACING_MS = 15000`) restricts fresh conversation starts (`turn === 0`) to 4/minute. Follow-up turns (`turn > 0`) bypass this queue entirely.
- **Hourly Turn Volume Protection (`PerUserThrottled`)**:
  - Microsoft enforces an account ceiling of ~120 turns in a 60-minute rolling window (`M365_SUSTAINED_MAX_TURNS = 120`).
  - Tripping this limit arms a 20-minute cooldown (`M365_USER_THROTTLE_COOLDOWN_SEC = 1200`).
  - **Protection**: A serialized Priority FIFO Turn Gatekeeper (`paceTurnVelocity`) enforces a minimum 1500ms wire pacing (`M365_MIN_TURN_SPACING_MS = 1500`) to eliminate thundering herd bursts. Short-term bursts are bounded to 35 turns per 10 minutes (`M365_BURST_MAX_TURNS = 35`, soft warning at 30). Forcing retries (`attempt > 0`) queue with priority to jump ahead of normal turns while preserving FIFO order among retries.
- **Local Circuit Breaker Shield**:
  - When upstream throttling (`PerScenarioThrottled` or `PerUserThrottled`) is detected, the proxy enters local cooldown (1800s or 1200s).
  - During this window, requests are intercepted locally and return **`HTTP 429 Too Many Requests`** with a client header capped at **`Retry-After: 60`** (`M365_MAX_RETRY_AFTER_SEC = 60`).
  - **Zero traffic is sent to Microsoft** during cooldown, letting Microsoft's token bucket fully recover while standard OpenAI clients (OpenCode, Pi) pause and automatically resume without failing the turn.
- **Content Safety Separation vs. Confabulation**:
  - Upstream content policy violations (`looksLikeSafetyRefusal`) fail immediately with **`HTTP 400 content_policy_refusal`** and flush session context.
  - Unresolved tool confabulations that persist after exhausting forcing retries fail closed with **`HTTP 502 unresolved_tool_refusal`**.
- **Bypassing Confabulation Retries (`M365_DISABLE_CONFAB_DETECTION=1`)**:
  - With advisor framing, model confabulation drops to ~0.3% of turns while keyword checks can trigger false positives on legitimate completion prose.
  - Setting `M365_DISABLE_CONFAB_DETECTION=1` disables proxy-level confabulation retries and 502 fails, passing prose deliverables directly through to client orchestrators.

### 4. Conversation Reuse & Session Isolation
- Each distinct client conversation maps to an isolated M365 session (`sessionId` + `conversationId`).
- The WebSocket client reconnects per turn while M365 maintains server-side conversation history.
- The `SessionPool` isolates concurrent agent sessions using SHA-256 fingerprinting of message history and session headers (`x-session-id`, `x-opencode-session`).
- Follow-up turns only transmit new delta messages, conserving conversational quota.

---

## 🤖 Supported Models

| Model ID | M365 Tone | Description |
|---|---|---|
| `gpt-5.6-think-deeper` / `gpt-5.6` | `Gpt_5_6_Reasoning` | GPT-5.6 reasoning — live-validated for complex agentic tasks and deep tool execution. |
| `gpt-5.6-quick` / `gpt-5.6-chat` | `Gpt_5_6_Chat` | GPT-5.6 fast chat — live-validated on DeepLeo. |
| `gpt-6-astra` / `gpt-6` | `Gpt_6_Astra` | Live GPT-6-named tone; routes through DeepLeo. Self-identifies as GPT-5 chat without reasoning trace — treat as a GPT-5-class chat tone. |
| `gpt-6.1-sol` / `gpt-6.1-sol-reasoning` / `sol` | `Gpt_61_Sol_Reasoning` | GPT-6.1 Sol reasoning. Limited/premium tone — same handshake-gated class as `Claude_Opus` (needs the Premium/PaidCopilot connection, which is the default). |
| `gpt-5.5-think-deeper` | `Gpt_5_5_Reasoning` | **Recommended default for coding & tool execution** — robust compliance and high benchmark solve rate. |
| `gpt-5.5` / `gpt-5.5-quick` | `Gpt_5_5_Chat` | GPT-5.5 fast chat. |
| `claude-sonnet-5.5` / `claude-sonnet` / `claude` | `Claude_Sonnet` | Anthropic Claude Sonnet 4.5/5.5 via Sydney backend (agent-less path). |
| `claude-sonnet-5` | `Claude_Sonnet_5` | Claude Sonnet 5 — live-validated on DeepLeo. |
| `claude-sonnet-think-deeper` | `Claude_Sonnet_Reasoning` | Claude Sonnet with reasoning traces. |
| `claude-opus-5.5` / `claude-opus` / `opus-5.5` | `Claude_Opus` | Anthropic Claude Opus 4.8 / 5.5 on DeepLeo with full tool calling capability. |
| `m365-copilot` / `auto` | `magic` | Default auto-routing chat tone. Unreliable for tools (confabulates; proxy defaults to `gpt-5.5-think-deeper` for tool turns). |
| `quick` | `Gpt_Quick` | Fast responses. |
| `think-deeper` | `Gpt_Reasoning` | Slower, thorough generic reasoning tone. |
| `gpt-5.4` / `gpt-5.4-think-deeper` / `gpt-5.4-quick` | `Gpt_5_4_*` | Legacy GPT-5.4 generation. |
| `gpt-5.3` / `gpt-5.3-think-deeper` / `gpt-5.3-quick` | `Gpt_5_3_*` | Legacy GPT-5.3 generation. |
| `gpt-5.2` / `gpt-5.2-think-deeper` / `gpt-5.2-quick` | `Gpt_5_2_*` | Legacy GPT-5.2 generation. |

> 💡 **Model Selection Recommendation:**
> - For agentic coding with tool execution, always specify **`gpt-5.5-think-deeper`** (or `gpt-5.6-think-deeper`). A request without a `model` parameter defaults to `gpt-5.5-think-deeper`.
> - The default `m365-copilot` (`magic`) tone is tuned for general prose and confabulates on tool execution (~0% solve rate).
> - Older reasoning tones (`gpt-5.2` through `gpt-5.4` `*-think-deeper`) route through DeepLeo prompt meta-analysis and can disengage under large tool payloads.

---

## 🔐 Authentication

The proxy uses Azure MSAL with PKCE across three authentication stages:

1. **Silent Refresh**: Uses cached OAuth tokens stored in `~/.config/opencode-m365/msal-cache.json`. Standard execution path; instant and headless.
2. **Automated Login**: Uses Playwright/Chromium to automate the Entra ID login flow using credentials and TOTP seeds from `secrets.json`.
3. **Interactive Approval**: Fallback visible browser window for complex tenant setups.

Acquired token scopes:
- `substrate.office.com/sydney/*` — M365 Copilot chat and SignalR WebSocket access.
- `api.powerplatform.com/.default` — Copilot Studio agent provisioning.
- `api.bap.microsoft.com/.default` — PowerPlatform environment discovery.

### Getting the TOTP Secret

#### From an Existing Password Manager
If you use 1Password, Bitwarden, KeePassXC, Aegis, or Ente Auth for MFA, open the item's one-time password field and reveal the secret. You will get either a raw base32 string or an `otpauth://totp/...?secret=JBSWY3DPEHPK3PXP&...` URI; extract the `secret` value.

#### Enrolling a New Method (if trapped in Microsoft Authenticator)
Microsoft Authenticator does not display existing seeds. Enroll a parallel authenticator entry:
1. Navigate to [https://aka.ms/mfasetup](https://aka.ms/mfasetup) (**My Account → Security info**).
2. Select **Add sign-in method → Authenticator app**.
3. Click **"I want to use a different authenticator app"** *(crucial: the default path enforces push notifications with no exportable seed)*.
4. On the QR code screen, click **"Can't scan image?"**.
5. Copy the displayed **Secret key** (your base32 seed).
6. Verify and finish enrollment:
   ```sh
   oathtool --totp -b "YOUR_COPIED_SECRET"
   ```
   Enter the resulting 6-digit code into the Microsoft setup page to confirm.

### If Your Tenant Has No TOTP Option
If your organization enforces push notifications, FIDO2/WebAuthn hardware keys, Windows Hello, or third-party federated IdPs (Okta, Ping, Duo), automated credential login cannot run.

Set `M365_ENABLE_INTERACTIVE_APPROVAL=1` and start the proxy:
```sh
export M365_ENABLE_INTERACTIVE_APPROVAL=1
m365-proxy 4141
```
A visible browser window opens once. Complete SSO and MFA manually. The proxy intercepts the OAuth callback code, exchanges it via MSAL, and saves the tokens to `msal-cache.json`. Subsequent starts refresh silently without opening a browser window.
- Set `M365_NO_INTERACTIVE=1` on headless servers, systemd units, or CI environments to forbid opening browser windows and fail loudly instead.

---

## ❄️ NixOS Service

The repository provides a Nix flake with an automated NixOS module:

```nix
# flake.nix
{
  inputs.m365.url = "github:cramt/m365-copilot-proxy";

  outputs = { nixpkgs, m365, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        m365.nixosModules.default
        {
          services.m365-copilot-proxy = {
            enable = true;
            # JSON containing { email, password, mfaSecret }
            # Kept out of the Nix store, delivered via systemd LoadCredential
            secretsFile = "/run/secrets/m365-copilot.json";
            # port = 4141;          # default
            # host = "127.0.0.1";   # default (unauthenticated proxy)
            # openFirewall = false;
          };
        }
      ];
    };
  };
}
```

The service runs under a hardened `DynamicUser` unit. State is stored in `/var/lib/m365-copilot-proxy`. To run the binary directly via Nix without deploying the module:
```sh
nix run github:cramt/m365-copilot-proxy -- 4141
```

---

## 🎨 Image Generation

M365 Copilot generates images through a server-side tool. The proxy provides direct programmatic access and chat-syntax generation:

### Programmatic API
```ts
import { generateImage } from "@m365-copilot/core";

const [img] = await generateImage("A minimalist flat-design logo of a lighthouse, teal and white.");
// img.data        -> Buffer (PNG binary bytes)
// img.base64      -> Base64 string for OpenAI b64_json payloads
// img.contentType -> "image/png"
// img.size, img.orientation
```

### Options & Aspect Ratios
```ts
await generateImage("a lighthouse on a cliff", { orientation: "portrait" }); // landscape | portrait | square
await generateImage("a lighthouse", { style: "icon" });                     // natural | icon | story | designer
```

### Chat-Syntax Generation
In tool-less chat mode, prompts such as `"draw me an image of a green teapot"` return images directly embedded as markdown data-URIs. (Set `M365_NO_IMAGE_GEN=1` to disable image generation in chat turns).

> ⚠️ **Quota Warning:** Image generation draws against a separate, scarcer daily quota distinct from the ~600-message chat limit. When exhausted, `generateImage()` throws an `ImageGenerationError` with `reason: "quota_exceeded"` (mapping to HTTP 429).

---

## 📈 Usage & Context-Window % in Responses

M365 Copilot does not report raw token counts over WebSocket. The proxy estimates conversational usage and includes M365-specific extension fields in the standard OpenAI `usage` block:

```json
"usage": {
  "prompt_tokens": 0,
  "completion_tokens": 0,
  "total_tokens": 0,
  "x_m365_conversation_messages": 42,
  "x_m365_conversation_max": 600,
  "x_m365_conversation_pct": 7,
  "x_m365_conversation_remaining": 558,
  "x_m365_content_origin": "DeepLeo",
  "x_m365_message_type": null,
  "x_m365_turn_count": 3,
  "x_m365_classifier_scores": {
    "BotOffense": 1.27e-7,
    "dea_violation": 2.81e-6
  },
  "x_m365_dea_score": 2.81e-6,
  "x_m365_offense_score": 1.27e-7
}
```

- **`x_m365_conversation_*`**: Tracks consumption against the hard ~600 messages per conversation ceiling.
- **`x_m365_dea_score`**: M365's internal Disengaged-Eligibility Answer classifier score. Clean tool calls register at ~1 × 10⁻⁸, regular prose at ~1 × 10⁻⁶, and jailbreak-shaped prompts escalate to ~1 × 10⁻³. Disengagement triggers above ~2 × 10⁻³.

---

## 📁 Config Files

All configuration and cache files reside in `~/.config/opencode-m365/`:

| File | Description |
|---|---|
| `secrets.json` | Account credentials (`email`, `password`, `mfaSecret`). |
| `msal-cache.json` | Azure MSAL OAuth token cache (managed automatically). |
| `agent-id.json` | Cached Copilot Studio agent ID (`T_{titleId}.{botId}.gpt.default`). |
| `proxy-state.json` | Persisted rate-limiter tokens, turn gatekeeper history, circuit breaker level, and metrics. |
| `debug.log` | Debug log file (active when `M365_DEBUG=1` or `M365_TRACE=1`). |

---

## ⚙️ Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| **Logging & Diagnostics** | | |
| `M365_DEBUG` | `0` | Enable truncated debug logging to `debug.log`. |
| `M365_TRACE` | `0` | Enable full untruncated logging of all WebSocket frames, prompts, and completions (implies `M365_DEBUG`). |
| `M365_LOG_STDOUT` | `0` | Mirror debug lines to stdout in addition to `debug.log`. |
| `M365_DUMP_FRAMES` | `0` | Save raw WebSocket frames to `~/.config/opencode-m365/frames/<requestId>.ndjson`. |
| **Tool Calling & Execution** | | |
| `M365_ALLOW_MULTI_TOOL` | `0` | Allow models to emit multiple tool calls in a single turn. By default, only the first call is executed. |
| `M365_INJECT_REPLY_TOOL` | `0` | Inject a synthetic `reply(text)` tool, enforcing tool-calling semantics even on prose turns. |
| `M365_CONFAB_RETRIES` | `3` | Maximum retry re-prompts within the same conversation when the model confabulates an inability or unearned mutation claim. |
| `M365_NO_CONFAB_RETRY` | `0` | Set to `1` to disable proxy-level confabulation forcing retries. |
| `M365_DISABLE_CONFAB_DETECTION` | `0` | Set to `1` to bypass all proxy-level confabulation detection and terminal 502 errors, passing prose directly to orchestrators. |
| **Degradation Backoff** | | |
| `M365_NO_BACKOFF` | `0` | Set to `1` to disable pacing backoff on empty/throttled responses. |
| `M365_BACKOFF_THRESHOLD` | `3` | Consecutive empty/throttled responses across distinct conversations before triggering backoff. |
| `M365_BACKOFF_WINDOW_MS` | `120000` | Window (ms) for evaluating backoff threshold (2 minutes). |
| `M365_BACKOFF_BASE_MS` | `90000` | Initial pacing delay (ms) for backoff (90 seconds). |
| `M365_BACKOFF_MAX_MS` | `600000` | Maximum escalated backoff delay (ms) (10 minutes). |
| **Circuit Breaker & Cooldowns** | | |
| `M365_THROTTLE_COOLDOWN_SEC` | `1800` | Cooldown (seconds) when upstream `PerScenarioThrottled` is tripped (30 minutes). |
| `M365_USER_THROTTLE_COOLDOWN_SEC` | `1200` | Cooldown (seconds) when upstream `PerUserThrottled` is tripped (20 minutes). |
| `M365_MAX_RETRY_AFTER_SEC` | `60` | Maximum `Retry-After` header value (seconds) returned on HTTP 429 during circuit breaker shielding. |
| **Dual-Horizon Rate Limiting & Pacing** | | |
| `M365_SESSION_BUCKET_CAPACITY` | `10` | Maximum fresh-conversation (`turn === 0`) burst tokens. |
| `M365_SESSION_REFILL_MS` | `150000` | Refill duration (ms) per conversation token (2.5 minutes). |
| `M365_NEW_SESSION_SPACING_MS` | `15000` | Minimum spacing (ms) between fresh session starts (15 seconds, caps new threads at 4/min). |
| `M365_MIN_TURN_SPACING_MS` | `1500` | Wire pacing minimum spacing (ms) between consecutive turns through the gatekeeper. |
| `M365_BURST_MAX_TURNS` | `35` | Maximum turns allowed in the 10-minute burst window before enforced drain delay. |
| `M365_BURST_SOFT_TURNS` | `30` | Turn threshold in 10-minute burst window where soft pacing resistance begins. |
| `M365_BURST_WINDOW_MS` | `600000` | Burst window duration (ms) (10 minutes). |
| `M365_SUSTAINED_MAX_TURNS` | `120` | Maximum turns allowed across the 60-minute macro-window before safety pauses. |
| `M365_SUSTAINED_WARN_TURNS` | `90` | Turn threshold in 60-minute window where progressive 5s–25s pacing resistance begins. |
| `M365_SUSTAINED_WINDOW_MS` | `3600000` | Sustained window duration (ms) (60 minutes). |
| **SLM Turn Classifier** | | |
| `M365_CLASSIFIER_OPENAI_URL` | unset | Remote OpenAI-compatible endpoint URL for turn classifier (e.g. `http://gpu-host:11434/v1`). If unset, uses in-process `@kessler/gemma` ONNX. |
| `M365_CLASSIFIER_OPENAI_MODEL` | `gemma4:e2b` | Model name requested at remote classifier endpoint. |
| `M365_CLASSIFIER_OPENAI_API_KEY` | unset | API key for remote classifier endpoint (falls back to `OPENAI_API_KEY`). |
| `M365_CLASSIFIER_TIMEOUT_MS` | `10000` | Max milliseconds to wait for remote GPU classifier before falling back to local ONNX (10 seconds). |
| `M365_CLASSIFIER_MAX_TOKENS` | `1000` | Token budget for classifier reasoning and tag output. |
| **State & Context Limits** | | |
| `M365_STATE_FILE` | unset | Custom path for `proxy-state.json`. |
| `M365_DATA_DIR` | `~/.config/opencode-m365` | Base data directory for secrets, cache, and logs. |
| `M365_CONTEXT_WINDOW` | `1000000` | Advertised `context_window` size returned on `GET /v1/models` (1M tokens). |
| `M365_MAX_OUTPUT_TOKENS` | `1000000` | Advertised `max_output_tokens` returned on `GET /v1/models` (1M tokens). |
| **Authentication & Browser Automation** | | |
| `M365_ENABLE_INTERACTIVE_APPROVAL`| `0` | Allow visible browser window for manual SSO/MFA sign-in when automated login fails or is unavailable. |
| `M365_NO_INTERACTIVE` | `0` | Hard-disable visible browser login; forces loud failure on headless hosts. |
| `M365_INTERACTIVE_TIMEOUT_MS` | `600000` | Timeout (ms) for manual interactive approval sign-in (10 minutes). |
| `M365_BROWSER_PROFILE` | unset | Custom persistent browser profile directory to retain AAD SSO cookies. |
| `M365_LOGIN_UA` | unset | Custom User-Agent string for Playwright browser login. |
| `M365_LOGIN_LOCALE` | `en-GB` | Browser locale presented during login fingerprinting. |
| `M365_LOGIN_TIMEZONE` | `Europe/Copenhagen` | Browser timezone presented during login fingerprinting. |
| `CHROMIUM_PATH` | unset | Path to external Chromium binary (recommended on NixOS). |
| `M365_CACHE_FILE` | unset | Custom path for `msal-cache.json`. |
| `M365_SECRETS_FILE` | unset | Custom path for `secrets.json`. |

---

## 💻 Development & Testing

```sh
pnpm install
pnpm build              # Build all packages via tsdown
pnpm run dev            # Start standalone proxy on :4141 with live reload
pnpm run test:unit      # Run unit test suite (vitest; pure offline mocks)
pnpm run test:live      # Run live integration tests against real M365 (requires credentials)
```

### End-to-End Live Verification
Verify tool execution, multi-turn continuity, and agent mode inside the Nix development shell:
```sh
nix develop --command bash -c 'M365_DEBUG=1 node scripts/proxy-verify.mjs --agent --multiturn'
```

---

## ⚠️ Known Limitations

- **Disengaged Filter on Large Toolsets**: M365 Copilot's server-side safety filter disengages when prompted with excessive tool definitions. Keep client toolsets lean (e.g. 4–6 core tools like `read`, `list`, `edit`, `write`, `bash`).
- **Emulated Tool Calling**: Function calling is prompt-emulated via fenced blocks and a Copilot Studio bot rather than native engine tool calling.
- **Reasoning Latency**: Thinking models (`gpt-5.5-think-deeper`, `gpt-5.6-think-deeper`) require 10–30 seconds per turn for deep reasoning traces.
- **Per-Conversation Quota**: Hard limit of ~600 messages per conversation (mitigated by session reuse and delta message sending).
- **Tool-Call Streaming Buffering**: Responses without tools stream tokens in real-time. Turns with tool calls are buffered server-side to parse and validate markdown fence syntax before emitting OpenAI-compliant tool-call chunks. Heartbeats are sent to keep client connections active.

---

## 📄 License

[MIT](LICENSE). Use at your own risk. This project communicates with Microsoft's undocumented APIs using your own credentials and account. You are responsible for compliance with your tenant's terms of service and acceptable use policies.

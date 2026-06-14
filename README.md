<div align="center">

# 🐋 pi-deepseek-provider

**DeepSeek V4 Pro, V4 Flash & Reasoner for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Native DeepSeek API with 1M context, thinking mode, and prefix cache optimization._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **DeepSeek V4 Pro** — Flagship model with thinking mode, 1M context, and 384K max output
- **DeepSeek V4 Flash** — Fast and affordable model with thinking mode, 1M context, and 384K max output
- **DeepSeek Reasoner (deprecated)** — Legacy reasoning model (maps to V4 Flash thinking mode)
- **DeepSeek Chat (deprecated)** — Legacy non-reasoning model (maps to V4 Flash non-thinking mode)
- **Prefix Cache Optimization** — Six strategies to keep DeepSeek's automatic prefix cache warm, reducing costs by up to 99%
- **Reasoning Effort Control** — `high`/`max` effort levels for thinking mode
- **Anthropic API Compatible** — Also available at `https://api.deepseek.com/anthropic`

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/monotykamary/pi-deepseek-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export DEEPSEEK_API_KEY=your-api-key-here

pi
```

Get your API key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-deepseek-provider.git
   cd pi-deepseek-provider
   ```

2. Set your DeepSeek API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export DEEPSEEK_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-deepseek-provider
   ```

## Available Models

| Model | Context | Reasoning | Reasoning Effort | Input $/M | Output $/M | Cache Hit $/M |
|-------|---------|-----------|------------------|-----------|------------|---------------|
| DeepSeek V4 Flash | 1M | ✅ | ✅ | $0.140 | $0.280 | $0.003 |
| DeepSeek V4 Pro | 1M | ✅ | ✅ | $0.435 | $0.870 | $0.004 |

*Costs are per million tokens. Prices subject to change — check [api-docs.deepseek.com](https://api-docs.deepseek.com/quick_start/pricing) for current pricing.*

**Note:** The model names `deepseek-chat` and `deepseek-reasoner` will be deprecated on 2026/07/24. They correspond to the non-thinking mode and thinking mode of `deepseek-v4-flash`, respectively. Use `deepseek-v4-flash` and `deepseek-v4-pro` for new projects.

## Prefix Cache Optimization

DeepSeek offers **automatic prefix caching**: when successive API requests share the same byte-identical prefix, the cached portion is charged at the "cache hit" rate — currently **~99% cheaper** than the regular input rate. This extension implements six strategies to keep that prefix warm, ported from the [Reasonix](https://github.com/esengine/deepseek-reasonix) project's DeepSeek-specific optimizations:

### 1. Schema Canonicalization

Tool schemas are a large chunk of the request prefix and the most common source of cache-busting — trivial re-ordering of `required` arrays or property keys produces different bytes even though the logical schema is unchanged. This extension hooks `before_provider_request` and canonicalizes all tool schemas before the request is sent:

- Sorts `required` arrays alphabetically
- Recursively sorts JSON object keys
- Ensures the same logical schema always produces identical bytes

**Impact:** Prevents silent cache invalidation from pi's internal tool resolution order.

### 2. Cache-Aware Compaction Gating

Compaction is the biggest cache-killer — it rewrites the message history, invalidating the entire cached prefix. This extension intercepts `session_before_compact` and applies Reasonix's strategy:

| Threshold | Context % | Action |
|-----------|-----------|--------|
| Soft | 50% | Log notice, don't compact |
| Hard | 80% | Allow compaction |
| Stuck | Consecutive | Pause auto-compaction |

- **Economic check:** Skips compaction when fewer than 4 messages would be summarized — the summarizer API call costs more than it saves.
- **Stuck guard:** If compaction can't reduce context below the threshold (system prompt + one turn > 80% of window), pauses auto-compaction and lets the prefix grow append-only instead of cratering the cache every turn.

**Impact:** Prevents the #1 cause of cache invalidation in long sessions.

### 3. Cache Hit Diagnostics

Tracks the prefix shape (hash of system prompt + canonical tool schemas) across turns. When the prefix changes between turns, logs a warning explaining what changed (`system-prompt-changed`, `tool-schemas-changed`) plus the previous cache hit rate. This gives you visibility into *why* your cache hit rate dropped.

**Impact:** Makes cache issues debuggable instead of mysterious.

### 4. Session-Aggregate Cache Display

Shows the cumulative cache hit rate across the entire session in the status line (`cache 87% (~42,000 cached tokens)`). The session-aggregate rate is steadier than the volatile per-turn rate and persists across compaction events.

**Impact:** Real-time visibility into whether the cache optimizations are working.

### 5. Reasoning Content Stripping on Replay

DeepSeek's reasoner returns `reasoning_content` in responses. Pi round-trips this as thinking content on assistant messages — every turn re-sends all prior reasoning at the full (uncached) input rate. For long agent sessions with many tool-call rounds, this accumulated thinking content can be hundreds of thousands of tokens.

This extension strips thinking content from older assistant messages, keeping reasoning only from the most recent N turns (configurable via `DEEPSEEK_CACHE_KEEP_THINKING_TURNS`, default 2). Stripped thinking is replaced with `[thinking stripped for cache efficiency]`.

**Tradeoff:** The model loses visibility into its own earlier reasoning, but gains cache efficiency. For long coding sessions where the model primarily relies on recent tool results and the current file state, the tradeoff is strongly favorable.

**Impact:** Reduces the prefix by the size of all round-tripped thinking beyond the last N turns.

### 6. System Prompt Freeze Warning

DeepSeek's prefix cache requires the byte-stable prefix to remain identical across turns. Any mutation invalidates the entire cached prefix. This extension logs a warning when the system prompt changes between DeepSeek turns, helping you identify which extensions or features are busting the cache.

**Impact:** Catches system-prompt mutations that would otherwise silently invalidate the cache.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | Your DeepSeek API key (fallback if not in auth.json) |
| `DEEPSEEK_CACHE_STRIP_THINKING` | `"true"` | Strip older thinking content to reduce prefix size. Set to `"false"` to disable. |
| `DEEPSEEK_CACHE_KEEP_THINKING_TURNS` | `"2"` | Number of recent turns to keep full thinking content for. Only applies when stripping is enabled. |
| `DEEPSEEK_CACHE_PROVIDERS` | — | Comma-separated list of additional providers to enable cache optimizations for (e.g., `openrouter,together`). |

### Using with Other Providers

The cache optimizations activate automatically for DeepSeek models by detecting the model ID — they work regardless of which provider routes the request. Specifically, optimizations are enabled when **any** of these conditions are true:

1. The provider is `deepseek` (direct API)
2. The model ID starts with `deepseek-` or `deepseek/` (e.g., OpenRouter's `deepseek/deepseek-v4-flash`)
3. The provider is listed in `DEEPSEEK_CACHE_PROVIDERS` env var


## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model deepseek deepseek-v4-pro
```

Or start pi directly with a DeepSeek model:

```bash
pi --provider deepseek --model deepseek-v4-pro
```

### Thinking Mode

DeepSeek V4 models support both thinking and non-thinking modes. Thinking mode is enabled by default. In pi, reasoning models use the `deepseek` thinking format which sends `thinking: {type: "enabled/disabled"}` plus `reasoning_effort` mapped from pi's thinking levels.

To control reasoning effort, use the `--reasoning-effort` flag:

```bash
pi --provider deepseek --model deepseek-v4-pro --reasoning-effort max
```

Effort levels: `high` (default for regular requests), `max` (default for agent/coding requests).

## Authentication

The DeepSeek API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "deepseek": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `DEEPSEEK_API_KEY`

Get your API key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-deepseek-provider"
  ]
}
```

### Compat Settings

DeepSeek's API uses these provider-specific compatibility settings:

- **`thinkingFormat: "deepseek"`** — Reasoning models (V4 Pro, V4 Flash). Sends `thinking: {type: "enabled"/"disabled"}` to toggle thinking mode. When enabled, `reasoning_effort` is mapped via `thinkingLevelMap` (`high` → `"high"`, `xhigh` → `"max"`). Minimal/low/medium are unsupported (null).
- **`supportsReasoningEffort: true`** — V4 models. Supports `reasoning_effort: "high" | "max"`.
- **`requiresReasoningContentOnAssistantMessages: true`** — V4 models. Replayed assistant messages include empty `reasoning_content` when reasoning is enabled, required by DeepSeek's API.
- **`supportsDeveloperRole`, `supportsStore`, `maxTokensField`** — Auto-detected from `baseUrl` (deepseek.com). Not explicitly set.

### Patch Overrides

The `patch.json` file contains overrides that are applied on top of `models.json` data. This is useful for:
- Correcting API-derived values (e.g., marking a model as reasoning-capable)
- Adding compat settings that the API doesn't provide
- Overriding pricing when official rates change

## Updating Models

Run the update script to fetch the latest models from DeepSeek's API:

```bash
export DEEPSEEK_API_KEY=your-api-key
node scripts/update-models.js
```

This will:
1. Fetch models from `https://api.deepseek.com/models`
2. Preserve pricing and compat from existing `models.json`
3. Apply overrides from `patch.json`
4. Update `models.json` and the README model table

A GitHub Actions workflow runs this daily and creates a PR if models have changed.

## License

MIT

<div align="center">

# 🐋 pi-deepseek-provider

**DeepSeek V4 Pro, V4 Flash & Reasoner for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Native DeepSeek API with 1M context, thinking mode, and live model sync._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

## Pi 1.0 compatibility

Tested with Pi **1.0.0**. Host-provided packages remain wildcard peers; development uses exact SDK pins.
Run `bun run test:pi` for offline manifest, catalog, lifecycle and streaming checks. To test an installed host, set `PI1_HOST_PACKAGE` to its package directory; add `PI1_HOST_ENTRY=bundle` for its bundled CLI runtime. The probe stubs all network requests and never uses a live provider endpoint.

---

## Features

- **DeepSeek V4 Pro** — Flagship model with thinking mode, 1M context, and 384K max output
- **DeepSeek V4 Flash** — Fast and affordable model with thinking mode, 1M context, and 384K max output
- **DeepSeek Reasoner (deprecated)** — Legacy reasoning model (maps to V4 Flash thinking mode)
- **DeepSeek Chat (deprecated)** — Legacy non-reasoning model (maps to V4 Flash non-thinking mode)
- **Reasoning Effort Control** — `high`/`max` effort levels for thinking mode
- **Anthropic API Compatible** — Also available at `https://api.deepseek.com/anthropic`
- **Quiet live model sync** — Models refresh from the DeepSeek API in the background, at most hourly and by one pi process at a time ([details](#model-sync))

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
| Deepseek Flash | 131K | ❌ | ❌ | — | — | — |
| DeepSeek V4 Pro | 1M | ✅ | ✅ | $0.43 | $0.87 | $0.00 |

*Costs are per million tokens. Prices subject to change — check [api-docs.deepseek.com](https://api-docs.deepseek.com/quick_start/pricing) for current pricing.*

**Note:** The model names `deepseek-chat` and `deepseek-reasoner` will be deprecated on 2026/07/24. They correspond to the non-thinking mode and thinking mode of `deepseek-v4-flash`, respectively. Use `deepseek-v4-flash` and `deepseek-v4-pro` for new projects.

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPSEEK_API_KEY` | No | Your DeepSeek API key (fallback if not in auth.json) |
| `PI_PROVIDER_SYNC_TTL_MS` | No | Model sync freshness window in ms (default `3600000`; `0` = revalidate every session) |

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

- **`thinkingFormat: "deepseek"`** — Reasoning models (V4 Pro, V4 Flash). Sends `thinking: {type: "enabled"/"disabled"}` to toggle thinking mode. When enabled, `reasoning_effort` is mapped via `thinkingLevelMap` (`high` → `"high"`, `max` → `"max"`). Minimal/low/medium are unsupported (null).
- **`supportsReasoningEffort: true`** — V4 models. Supports `reasoning_effort: "high" | "max"`.
- **`requiresReasoningContentOnAssistantMessages: true`** — V4 models. Replayed assistant messages include empty `reasoning_content` when reasoning is enabled, required by DeepSeek's API.
- **`supportsDeveloperRole`, `supportsStore`, `maxTokensField`** — Auto-detected from `baseUrl` (deepseek.com). Not explicitly set.

### Patch Overrides

The `patch.json` file contains overrides that are applied on top of `models.json` data. This is useful for:
- Correcting API-derived values (e.g., marking a model as reasoning-capable)
- Adding compat settings that the API doesn't provide
- Overriding pricing when official rates change

## Model sync

Neither startup nor requests wait on the network. pi starts with the cached catalog
(`~/.pi/agent/cache/deepseek-models.json`, falling back to the bundled `models.json`) and, on a session's first
DeepSeek request, revalidates against `/models` in the background — only when:

- a DeepSeek API key is configured (no key, no request),
- the cache is older than 1 hour, missing, or was fetched with a different API key, and
- no other pi process is already refreshing it (a `deepseek-models.lock` file next to the cache).

So `/new`, `/reload`, `pi -p` and fan-out child agents share one cache instead of each calling the API; a
session that skips the fetch still picks up a cache another process refreshed. A failed refresh is retried after
5 minutes at the earliest. `PI_PROVIDER_SYNC_TTL_MS` changes the window (`0` revalidates in every session).
Only a hash fingerprint of the key is stored (`deepseek-models.sync.json`), never the key itself.

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

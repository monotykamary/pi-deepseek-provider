# pi-deepseek-provider

A [pi](https://github.com/badlogic/pi-mono) extension that registers [DeepSeek](https://deepseek.com/) as a custom provider. Access DeepSeek V4 Pro, V4 Flash, and Reasoner models through the DeepSeek API.

## Features

- **DeepSeek V4 Pro** — Flagship model with thinking mode, 1M context, and 384K max output
- **DeepSeek V4 Flash** — Fast and affordable model with thinking mode, 1M context, and 384K max output
- **DeepSeek Reasoner (deprecated)** — Legacy reasoning model (maps to V4 Flash thinking mode)
- **DeepSeek Chat (deprecated)** — Legacy non-reasoning model (maps to V4 Flash non-thinking mode)
- **Context Caching** — Cache hit pricing for reduced costs on repeated prompts
- **Reasoning Effort Control** — `high`/`max` effort levels for thinking mode
- **Anthropic API Compatible** — Also available at `https://api.deepseek.com/anthropic`

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-deepseek-provider
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
| DeepSeek V4 Pro | 1M | ✅ | ✅ | $1.740 | $3.480 | $0.145 |
| DeepSeek V4 Flash | 1M | ✅ | ✅ | $0.140 | $0.280 | $0.028 |
| DeepSeek Chat (deprecated) | 1M | ❌ | ❌ | $0.140 | $0.280 | $0.028 |
| DeepSeek Reasoner (deprecated) | 1M | ✅ | ✅ | $0.140 | $0.280 | $0.028 |

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

DeepSeek V4 models support both thinking and non-thinking modes. Thinking mode is enabled by default. In pi, reasoning models automatically use the `openai` thinking format (`thinking: {type: "enabled"}`).

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

DeepSeek's API uses OpenAI-compatible settings:

- **`thinkingFormat: "openai"`** — Reasoning models (V4 Pro, V4 Flash). Sends `thinking: { type: "enabled" }` via `extra_body`.
- **`supportsReasoningEffort: true`** — V4 models. Supports `reasoning_effort: "high" | "max"`.
- **`maxTokensField: "max_completion_tokens"`** — All models. DeepSeek supports `max_completion_tokens`.
- **`supportsDeveloperRole: true`** — All models. DeepSeek accepts the `developer` role.
- **`supportsStore: true`** — All models. DeepSeek supports the `store` parameter.

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

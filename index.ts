/**
 * DeepSeek Provider Extension
 *
 * Registers DeepSeek (api.deepseek.com) as a custom provider.
 * Base URL: https://api.deepseek.com (OpenAI-compatible)
 *
 * DeepSeek's API is fully OpenAI-compatible and supports:
 *   - Thinking mode via `thinking: {type: "enabled/disabled"}` + `reasoning_effort`
 *   - Chain-of-thought in `reasoning_content` (interleaved format)
 *   - Context caching (cache hit pricing)
 *   - Anthropic API format at https://api.deepseek.com/anthropic
 *
 * Note: DeepSeek does NOT support the `developer` role (use `system` instead)
 * and does NOT support the `store` parameter. Both are set to false in compat.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json is always applied on top of whichever source won
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "deepseek": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export DEEPSEEK_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-deepseek-provider
 *
 * Then use /model to select from available models
 */

import type { ExtensionAPI, ModelRegistry } from "@mariozechner/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(models: JsonModel[], patch: PatchData): JsonModel[] {
  return models.map((model) => {
    const overrides = patch[model.id];
    if (!overrides) return model;

    const merged = { ...model };
    if (overrides.compat && merged.compat) {
      merged.compat = { ...merged.compat, ...overrides.compat };
      delete overrides.compat;
    }
    if (overrides.compat) {
      merged.compat = { ...(merged.compat || {}), ...overrides.compat };
      delete overrides.compat;
    }
    if (overrides.cost) {
      merged.cost = { ...merged.cost, ...overrides.cost };
      delete overrides.cost;
    }
    Object.assign(merged, overrides);

    if (!merged.reasoning && merged.compat?.thinkingFormat) {
      delete merged.compat.thinkingFormat;
    }
    if (merged.compat && Object.keys(merged.compat).length === 0) {
      delete merged.compat;
    }

    return merged;
  });
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "deepseek";
const BASE_URL = "https://api.deepseek.com";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

/** Transform a model from the DeepSeek /models API. API returns minimal data. */
function transformApiModel(apiModel: any): JsonModel {
  return {
    id: apiModel.id,
    name: generateDisplayName(apiModel.id),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  };
}

function generateDisplayName(id: string): string {
  if (id.startsWith("deepseek-v")) {
    const rest = id.replace("deepseek-v", "").replace(/-/g, " ");
    return `DeepSeek V${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
  if (id === "deepseek-chat") return "DeepSeek Chat";
  if (id === "deepseek-reasoner") return "DeepSeek Reasoner";
  return id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/** Fetch live models from the provider's /models endpoint. */
async function fetchLiveModels(apiKey: string): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel);
  } catch {
    return null;
  }
}

/** Load cached models from disk (synchronous, for stale-while-revalidate). */
function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Cache models to disk for next startup. */
function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Merge live-fetched models with embedded models.
 * Embedded data wins for known models (curated and correct).
 * New models from the live API are added.
 */
function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedIds = new Set(embeddedModels.map(m => m.id));
  const result = [...embeddedModels];
  for (const model of liveModels) {
    if (!embeddedIds.has(model.id)) {
      result.push(model);
    }
  }
  return result;
}

/**
 * Stale-While-Revalidate: serve stale (cache → embedded) immediately.
 */
function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (cached && cached.length > 0) return cached;
  return embeddedModels;
}

/**
 * Revalidate: fetch live, merge with embedded, cache on success.
 * Returns fresh base models, or null if fetch failed (caller keeps stale).
 */
async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[]): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("deepseek") ?? undefined;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // SWR: Serve stale immediately (cache → embedded) — zero-latency registration
  const embeddedModels = modelsData as JsonModel[];
  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = applyPatch(staleBase, patchData as PatchData);

  pi.registerProvider("deepseek", {
    baseUrl: BASE_URL,
    apiKey: "DEEPSEEK_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  // Revalidate in background: fetch live → merge → cache → hot-swap
  pi.on("session_start", async (_event, ctx) => {
    await resolveApiKey(ctx.modelRegistry);
    revalidateModels(cachedApiKey, embeddedModels).then((freshBase) => {
      if (freshBase) {
        pi.registerProvider("deepseek", {
          baseUrl: BASE_URL,
          apiKey: "DEEPSEEK_API_KEY",
          api: "openai-completions",
          models: applyPatch(freshBase, patchData as PatchData),
        });
      }
    });
  });
}

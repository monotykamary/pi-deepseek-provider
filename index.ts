import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek" | "openrouter" | "together" | "string-thinking";
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  const result = Array.from(modelMap.values());

  for (const model of result) {
    if (!model.reasoning) continue;
    if (!model.compat) {
      model.compat = {
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
      };
    } else {
      if (model.compat.thinkingFormat === undefined) {
        model.compat.thinkingFormat = "deepseek";
      }
      if (model.compat.supportsReasoningEffort === undefined) {
        model.compat.supportsReasoningEffort = true;
      }
      if (model.compat.requiresReasoningContentOnAssistantMessages === undefined) {
        model.compat.requiresReasoningContentOnAssistantMessages = true;
      }
    }
  }

  return result;
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "deepseek";
const BASE_URL = "https://api.deepseek.com";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

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

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
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

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      result.push({
        ...liveModel,
        ...embedded,
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  const cachedMap = new Map(cached.map(m => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("deepseek") ?? undefined;
}

// ─── Optimization 1: Schema Canonicalization ──────────────────────────────────
//
// DeepSeek offers automatic prefix caching: when successive requests share the
// same byte-identical prefix, the cached portion is charged at the cheaper
// "cache hit" rate (currently ~99% cheaper than input). Tool schemas are a
// large chunk of that prefix and the most common source of cache-busting —
// trivial re-ordering of `required` arrays or property keys produces different
// bytes even though the logical schema is unchanged.
//
// This hook canonicalizes tool schemas before the request is sent:
//   - Sorts `required` arrays alphabetically
//   - Recursively sorts object keys alphabetically
//   - Ensures the same logical schema always produces the same bytes

function canonicalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    return v.map(canonicalizeValue);
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Sort `required` arrays — the main source of cache-busting
    if (Array.isArray(obj["required"])) {
      obj["required"] = [...obj["required"]].sort();
    }
    // Sort keys for deterministic serialization
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalizeValue(obj[key]);
    }
    return sorted;
  }
  return v;
}

function canonicalizeToolSchemas(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => {
    if (!tool || typeof tool !== "object") return tool;
    const t = { ...tool } as Record<string, unknown>;
    if (t.function && typeof t.function === "object") {
      const fn = { ...(t.function as Record<string, unknown>) };
      if (fn.parameters && typeof fn.parameters === "object") {
        fn.parameters = canonicalizeValue(fn.parameters);
      }
      t.function = fn;
    }
    return t;
  });
}

// ─── Optimization 2: Cache-Aware Compaction Gating ──────────────────────────
//
// Compaction is the biggest cache-killer — it rewrites the message history,
// invalidating the entire prefix that DeepSeek cached. Reasonix's approach:
//
//   - Soft threshold (50%): log a notice but do NOT compact
//   - Hard threshold (80%): compact normally
//   - Stuck guard: if compaction can't get the prompt below the threshold
//     (system prompt + one turn > 80% of window), pause auto-compaction and
//     let the prefix grow append-only rather than cratering the cache every turn
//   - Economic check: don't compact if the region is too small to justify
//     the summarizer API call
//
// In pi, auto-compaction triggers when contextTokens > contextWindow - reserveTokens.
// We intercept `session_before_compact` to apply these policies for DeepSeek sessions.

const COMPACT_SOFT_RATIO = 0.5;
const COMPACT_HARD_RATIO = 0.8;
const MIN_COMPACT_MESSAGES = 4;

// ─── Optimization 3+4: Cache Diagnostics + Session-Aggregate Display ─────────
//
// Track prefix shape across turns so we can explain cache misses, and accumulate
// cache hit/miss tokens across the entire session for a steady aggregate rate.
//
// Prefix shape: hash(system_prompt + canonical_tools). If it changes between
// turns, we know the cache was busted. We log what changed (system vs tools).
//
// Session-aggregate: sum of all cacheRead/cacheWrite tokens across all turns.
// Steadier than the volatile single-turn rate; persists across compaction.

interface PrefixShape {
  systemHash: string;
  toolsHash: string;
  prefixHash: string;
}

interface CacheState {
  prevShape: PrefixShape | null;
  sessionCacheHit: number;
  sessionCacheMiss: number;
  consecutiveCompacts: number;
  compactStuck: boolean;
  turnCount: number;
}

function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function captureShape(systemPrompt: string, tools: unknown[]): PrefixShape {
  const toolsJson = JSON.stringify(canonicalizeToolSchemas(tools));
  return {
    systemHash: shortHash(systemPrompt),
    toolsHash: shortHash(toolsJson),
    prefixHash: shortHash(systemPrompt + "\n" + toolsJson),
  };
}

function compareShape(
  prev: PrefixShape | null,
  cur: PrefixShape,
  cacheHit: number,
  cacheMiss: number,
): string[] {
  if (!prev) return [];
  const reasons: string[] = [];
  if (prev.systemHash !== cur.systemHash) reasons.push("system-prompt-changed");
  if (prev.toolsHash !== cur.toolsHash) reasons.push("tool-schemas-changed");
  return reasons;
}

// ─── Optimization 5: Strip Reasoning Content on Replay ──────────────────────
//
// DeepSeek's reasoner returns `reasoning_content` in responses. Pi round-trips
// this as ThinkingContent on assistant messages. The provider requires
// `requiresReasoningContentOnAssistantMessages: true` so that replayed messages
// include an empty `reasoning_content` field — but the *content* of that thinking
// is still sent as full tokens each turn, counted as uncached prompt.
//
// For long sessions with many tool-call rounds, this accumulated thinking content
// can be a significant portion of the prefix. By stripping thinking content from
// older assistant messages (keeping only the most recent N turns' thinking), we
// reduce the prefix size and improve cache hit rates.
//
// This is a tradeoff: the model loses visibility into its own earlier reasoning,
// but gains cache efficiency. The number of turns to keep thinking for is
// configurable via DEEPSEEK_CACHE_KEEP_THINKING_TURNS (default: 2).

const KEEP_THINKING_TURNS = parseInt(
  process.env.DEEPSEEK_CACHE_KEEP_THINKING_TURNS || "2",
  10,
);

// ─── Optimization 6: System Prompt Freeze Enforcement ──────────────────────
//
// DeepSeek's prefix cache requires the byte-stable prefix (system prompt + tools)
// to remain identical across turns. Any mutation — even adding a single newline
// to the system prompt — invalidates the entire cached prefix and forces a full
// re-processing at the miss rate.
//
// This hook logs a warning when the system prompt changes between DeepSeek
// turns, helping users identify which extensions or features are busting their
// cache. It does NOT block the change — that would conflict with other
// extensions — but it provides the observability needed to fix the root cause.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isDeepSeekModel(ctx: { model?: { provider?: string; id?: string } }): boolean {
  return ctx.model?.provider === "deepseek";
}

function extractPayloadInfo(payload: unknown): {
  systemPrompt: string;
  tools: unknown[];
  messages: unknown[];
} {
  const p = payload as Record<string, unknown>;
  // OpenAI Chat Completions format
  const messages = Array.isArray(p.messages) ? p.messages : [];
  // System prompt may be in the first message with role "system" or "developer"
  let systemPrompt = "";
  const tools = Array.isArray(p.tools) ? p.tools : [];
  if (messages.length > 0) {
    const first = messages[0] as Record<string, unknown>;
    if (first.role === "system" || first.role === "developer") {
      systemPrompt = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
    }
  }
  return { systemPrompt, tools, messages };
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // SWR: Serve stale immediately (cache → embedded) — zero-latency registration
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("deepseek", {
    baseUrl: BASE_URL,
    apiKey: "$DEEPSEEK_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  // Session-scoped cache state
  const cacheState: CacheState = {
    prevShape: null,
    sessionCacheHit: 0,
    sessionCacheMiss: 0,
    consecutiveCompacts: 0,
    compactStuck: false,
    turnCount: 0,
  };

  let previousSystemPrompt: string | null = null;

  // Revalidate in background: fetch live → merge → cache → hot-swap
  //
  // Key resolution must NOT touch ctx — the session_start handler runs before
  // pi's own session replacement (e.g. --no-session → ephemeral), so any async
  // work that touches ctx will fire against a stale context. Instead, we resolve
  // the key lazily on first before_provider_request, which always runs on the
  // live session.
  let keyResolved = false;

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();

    // Reset cache diagnostics state on new session
    cacheState.prevShape = null;
    cacheState.sessionCacheHit = 0;
    cacheState.sessionCacheMiss = 0;
    cacheState.consecutiveCompacts = 0;
    cacheState.compactStuck = false;
    cacheState.turnCount = 0;
    previousSystemPrompt = null;
    keyResolved = false;
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });

  // ── Optimization 1: Schema Canonicalization ────────────────────────────────
  //
  // Hook before_provider_request to canonicalize tool schemas in the payload.
  // This ensures DeepSeek's prefix cache sees identical bytes even if pi's
  // internal tool resolution subtly re-orders properties.

  pi.on("before_provider_request", (event, ctx) => {
    if (!isDeepSeekModel(ctx)) return;

    // Lazy key resolution + SWR revalidation: fire once per session on the
    // first provider request, when we know the sesion is stable.
    if (!keyResolved) {
      keyResolved = true;
      ctx.modelRegistry.getApiKeyForProvider("deepseek").then((key: string | undefined) => {
        cachedApiKey = key ?? undefined;
        const signal = revalidateAbort?.signal;
        if (!signal?.aborted) {
          revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
            if (freshBase && !signal?.aborted) {
              pi.registerProvider("deepseek", {
                baseUrl: BASE_URL,
                apiKey: "$DEEPSEEK_API_KEY",
                api: "openai-completions",
                models: buildModels(freshBase, customModels, patches),
              });
            }
          });
        }
      }).catch(() => {
        // Key resolution failure is non-fatal
      });
    }

    const payload = event.payload as Record<string, unknown>;
    if (!payload || !Array.isArray(payload.tools)) return;

    payload.tools = canonicalizeToolSchemas(payload.tools);

    // ── Optimization 3: Cache Diagnostics ──────────────────────────────────
    //
    // Capture the prefix shape after canonicalization and compare with the
    // previous turn's shape. If the prefix changed, log what changed so the
    // user can diagnose cache misses.

    const { systemPrompt, tools, messages } = extractPayloadInfo(payload);
    const shape = captureShape(systemPrompt, tools);
    const reasons = compareShape(cacheState.prevShape, shape, cacheState.sessionCacheHit, cacheState.sessionCacheMiss);

    if (reasons.length > 0) {
      const pct = cacheState.sessionCacheHit + cacheState.sessionCacheMiss > 0
        ? Math.round(100 * cacheState.sessionCacheHit / (cacheState.sessionCacheHit + cacheState.sessionCacheMiss))
        : 0;
      console.warn(
        `[deepseek-cache] Prefix changed: ${reasons.join(", ")} — ` +
        `previous cache hit rate was ${pct}% across ${cacheState.turnCount} turns`
      );
    }

    cacheState.prevShape = shape;

    return payload;
  });

  // ── Optimization 4: Session-Aggregate Cache Display ────────────────────────
  //
  // Accumulate cache tokens from each assistant message and render the
  // aggregate rate in the status line. The session-aggregate rate is steadier
  // than the volatile per-turn rate because it encompasses the full session
  // and is unaffected by compaction events.

  pi.on("message_end", (event, ctx) => {
    if (!isDeepSeekModel(ctx)) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = event.message as any;
    if (msg.role !== "assistant") return;

    const usage = msg.usage as Record<string, number> | undefined;
    if (!usage) return;

    const hit = usage.cacheRead ?? 0;
    const miss = usage.cacheWrite ?? 0;

    cacheState.sessionCacheHit += hit;
    cacheState.sessionCacheMiss += miss;
    cacheState.turnCount++;

    const totalHit = cacheState.sessionCacheHit;
    const totalMiss = cacheState.sessionCacheMiss;
    const total = totalHit + totalMiss;

    if (total > 0 && ctx.hasUI) {
      const rate = Math.round(100 * totalHit / total);
      const costSavings = hit > 0 ? ` (~${hit.toLocaleString()} cached tokens)` : "";
      const plainText = `cache ${rate}%${costSavings}`;
      // Apply dim (grey) styling to match the rest of the pi footer
      const styledText = ctx.ui.theme?.fg("dim", plainText) ?? plainText;
      ctx.ui.setStatus("deepseek-cache", styledText);

      // Reset compaction stuck guard if the session is healthy
      if (rate >= 50) {
        cacheState.consecutiveCompacts = 0;
        cacheState.compactStuck = false;
      }
    }
  });

  // ── Optimization 2: Cache-Aware Compaction Gating ─────────────────────────
  //
  // Intercept compaction for DeepSeek sessions. Goals:
  //   1. Defer compaction until a higher threshold (hard 80% vs pi's default)
  //   2. Skip if too few messages to be worth the summarizer call
  //   3. Detect stuck compaction (can't get below threshold) and pause it

  pi.on("session_before_compact", (event, ctx) => {
    if (!isDeepSeekModel(ctx)) return;

    const { preparation } = event;
    const contextUsage = ctx.getContextUsage();
    if (!contextUsage || contextUsage.tokens === null) return;

    const { contextWindow } = contextUsage;
    if (contextWindow <= 0) return;

    const ratio = contextUsage.tokens / contextWindow;

    // Economic check: if the messages to summarize are too few, it's not worth
    // the summarizer API call (and the cache-bust that follows)
    const messagesToSummarize = preparation.messagesToSummarize?.length ?? 0;
    if (messagesToSummarize < MIN_COMPACT_MESSAGES) {
      console.warn(
        `[deepseek-cache] Compaction skipped: only ${messagesToSummarize} messages to summarize ` +
        `(minimum ${MIN_COMPACT_MESSAGES} for economic viability)`
      );
      return { cancel: true };
    }

    // Soft threshold: log but don't compact yet
    if (ratio < COMPACT_SOFT_RATIO) {
      console.warn(
        `[deepseek-cache] Context at ${(ratio * 100).toFixed(0)}% — below soft threshold ` +
        `${(COMPACT_SOFT_RATIO * 100).toFixed(0)}%. Compaction deferred to preserve cache.`
      );
      return { cancel: true };
    }

    // Between soft and hard: allow but warn about cache impact
    if (ratio < COMPACT_HARD_RATIO) {
      const hitRate = cacheState.sessionCacheHit + cacheState.sessionCacheMiss > 0
        ? Math.round(100 * cacheState.sessionCacheHit / (cacheState.sessionCacheHit + cacheState.sessionCacheMiss))
        : 0;
      console.warn(
        `[deepseek-cache] Context at ${(ratio * 100).toFixed(0)}% — between soft ` +
        `(${(COMPACT_SOFT_RATIO * 100).toFixed(0)}%) and hard (${(COMPACT_HARD_RATIO * 100).toFixed(0)}%) thresholds. ` +
        `Current cache hit rate: ${hitRate}%. Compacting will reset the prefix cache.`
      );
      // Allow compact — let pi decide
      return;
    }

    // Hard threshold hit, but check if we're stuck
    if (cacheState.compactStuck) {
      console.warn(
        `[deepseek-cache] Auto-compaction paused: the system prompt + one turn exceeds ` +
        `${(COMPACT_HARD_RATIO * 100).toFixed(0)}% of the context window. ` +
        `Compaction can't help — growing append-only instead.`
      );
      return { cancel: true };
    }

    // Hard threshold: allow compaction, but track if it fails to help
    cacheState.consecutiveCompacts++;
    if (cacheState.consecutiveCompacts >= 3) {
      cacheState.compactStuck = true;
      console.warn(
        `[deepseek-cache] Compaction stuck guard triggered: ${cacheState.consecutiveCompacts} consecutive ` +
        `compactions haven't reduced context below the threshold. Auto-compaction paused for DeepSeek.`
      );
      return { cancel: true };
    }

    // Allow the compaction to proceed
    return;
  });

  // ── Optimization 5: Strip Reasoning Content on Replay ─────────────────────
  //
  // DeepSeek round-trips reasoning_content (chain-of-thought) on every turn as
  // uncached prompt tokens. For long sessions this is expensive. Strip thinking
  // content from older assistant messages to reduce the prefix, keeping
  // reasoning only from the most recent N turns.
  //
  // This trades reasoning visibility for cache efficiency. The model can still
  // see its recent reasoning; only older thinking is pruned.
  //
  // Controlled by DEEPSEEK_CACHE_STRIP_THINKING (default: "true") and
  // DEEPSEEK_CACHE_KEEP_THINKING_TURNS (default: "2").

  const stripThinking = process.env.DEEPSEEK_CACHE_STRIP_THINKING !== "false";

  pi.on("context", (event, ctx) => {
    if (!stripThinking) return;
    if (!isDeepSeekModel(ctx)) return;

    const messages = event.messages;
    if (!messages || messages.length === 0) return;

    // Find the boundary: keep thinking for the last N user-turns
    // Count backwards from the end to find the last N user messages
    let userTurnCount = 0;
    let boundaryIdx = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = messages[i] as any;
      if (msg.role === "user") {
        userTurnCount++;
        if (userTurnCount >= KEEP_THINKING_TURNS) {
          boundaryIdx = i;
          break;
        }
      }
    }

    // Strip thinking content from messages before the boundary
    let modified = false;
    for (let i = 0; i < boundaryIdx; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = messages[i] as any;
      if (msg.role !== "assistant") continue;

      // Pi stores thinking as content items with type "thinking"
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      const hasThinking = content.some(
        (c: any) => c.type === "thinking"
      );
      if (!hasThinking) continue;

      // Replace thinking blocks with a minimal stub that preserves the
      // required reasoning_content structure but without the expensive text
      msg.content = content.map(
        (c: any) => {
          if (c.type === "thinking") {
            return { ...c, thinking: "[thinking stripped for cache efficiency]" };
          }
          return c;
        }
      );
      modified = true;
    }

    if (modified) {
      return { messages };
    }
  });

  // ── Optimization 6: System Prompt Freeze Enforcement ──────────────────────
  //
  // Log a warning when the system prompt changes between DeepSeek turns.
  // This does NOT block the change — only provides observability.

  pi.on("before_agent_start", (event, ctx) => {
    if (!isDeepSeekModel(ctx)) return;

    const currentPrompt = event.systemPrompt;
    if (previousSystemPrompt !== null && currentPrompt !== previousSystemPrompt) {
      const prevLen = previousSystemPrompt.length;
      const curLen = currentPrompt.length;
      const diff = curLen - prevLen;
      console.warn(
        `[deepseek-cache] System prompt changed between turns ` +
        `(${prevLen} → ${curLen} chars, ${diff > 0 ? "+" : ""}${diff}). ` +
        `This will invalidate the prefix cache. ` +
        `Check extensions/modifications that mutate the system prompt.`
      );
    }
    previousSystemPrompt = currentPrompt;
  });
}

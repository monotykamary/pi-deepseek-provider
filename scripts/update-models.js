#!/usr/bin/env node
/**
 * Update DeepSeek models from API
 *
 * Fetches models from https://api.deepseek.com/models and updates:
 * - models.json: Provider model definitions (enriched with pricing & compat)
 * - README.md: Model table in the Available Models section
 *
 * The DeepSeek /models API returns basic model info (id, owner, object type)
 * but does NOT include pricing, context length, or max output tokens.
 * Pricing and model specs are maintained in the existing models.json and
 * carried forward for known models. New models get default pricing that
 * must be manually updated in models.json.
 *
 * patch.json is applied at runtime by the provider — not baked into models.json.
 *
 * Requires DEEPSEEK_API_KEY environment variable.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS_API_URL = 'https://api.deepseek.com/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

// ─── Pricing from DeepSeek official docs ─────────────────────────────────────
// https://api-docs.deepseek.com/quick_start/pricing
// Prices are per 1M tokens
const PRICING = {
  'deepseek-v4-pro': {
    input: 1.74,
    output: 3.48,
    cacheRead: 0.145,
  },
  'deepseek-v4-flash': {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.028,
  },
  // deepseek-chat aliases deepseek-v4-flash (non-thinking mode)
  'deepseek-chat': {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.028,
  },
  // deepseek-reasoner aliases deepseek-v4-flash (thinking mode)
  'deepseek-reasoner': {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.028,
  },
};

// Default pricing for unknown models (use flash pricing as baseline)
const DEFAULT_PRICING = { input: 0.14, output: 0.28, cacheRead: 0.028 };

// ─── Model metadata ─────────────────────────────────────────────────────────

const MODEL_SPECS = {
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
  },
  'deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
  },
  'deepseek-chat': {
    name: 'DeepSeek Chat (deprecated)',
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  'deepseek-reasoner': {
    name: 'DeepSeek Reasoner (deprecated)',
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ Saved ${path.basename(filePath)}`);
}

// ─── API fetch ───────────────────────────────────────────────────────────────

async function fetchModels() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable is required');
  }

  console.log(`Fetching models from ${MODELS_API_URL}...`);
  const response = await fetch(MODELS_API_URL, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const models = data.data || [];
  console.log(`✓ Fetched ${models.length} models from API`);
  return models;
}

// ─── Transform API model → models.json entry ────────────────────────────────

function transformApiModel(apiModel, existingModelsMap) {
  const id = apiModel.id;

  // Start from existing model data if we have it (preserves pricing, compat, etc.)
  if (existingModelsMap[id]) {
    return { ...existingModelsMap[id] };
  }

  // New model — build from known specs + defaults
  const specs = MODEL_SPECS[id] || {};
  const pricing = PRICING[id] || DEFAULT_PRICING;

  const model = {
    id,
    name: specs.name || generateDisplayName(id),
    reasoning: specs.reasoning || false,
    input: ['text'],
    cost: {
      input: pricing.input,
      output: pricing.output,
      cacheRead: pricing.cacheRead,
      cacheWrite: 0,
    },
    contextWindow: specs.contextWindow || 1_000_000,
    maxTokens: specs.maxTokens || 384_000,
  };

  // Add compat settings
  model.compat = {
    maxTokensField: 'max_completion_tokens',
    supportsDeveloperRole: false,
    supportsStore: false,
  };

  if (model.reasoning && specs.thinkingFormat) {
    model.compat.thinkingFormat = specs.thinkingFormat;
  }
  if (specs.supportsReasoningEffort) {
    model.compat.supportsReasoningEffort = true;
  }

  return model;
}

function generateDisplayName(id) {
  // Handle known naming patterns
  if (id.startsWith('deepseek-v')) {
    const version = id.replace('deepseek-v', '').replace(/-/g, ' ');
    return `DeepSeek V${version.charAt(0).toUpperCase()}${version.slice(1)}`;
  }
  if (id === 'deepseek-chat') return 'DeepSeek Chat (deprecated)';
  if (id === 'deepseek-reasoner') return 'DeepSeek Reasoner (deprecated)';

  // Fallback: prettify the ID
  return id
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ─── README generation ──────────────────────────────────────────────────────

function formatContext(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toString();
}

function formatCost(cost) {
  if (cost === 0) return 'Free';
  if (cost === null || cost === undefined) return '-';
  return `$${cost.toFixed(3)}`;
}

function generateReadmeTable(models) {
  const lines = [
    '| Model | Context | Reasoning | Reasoning Effort | Input $/M | Output $/M | Cache Hit $/M |',
    '|-------|---------|-----------|------------------|-----------|------------|---------------|',
  ];

  for (const model of models) {
    const context = formatContext(model.contextWindow);
    const reasoning = model.reasoning ? '✅' : '❌';
    const reasoningEffort = model.compat?.supportsReasoningEffort ? '✅' : '❌';
    const inputCost = formatCost(model.cost.input);
    const outputCost = formatCost(model.cost.output);
    const cacheCost = formatCost(model.cost.cacheRead);

    lines.push(`| ${model.name} | ${context} | ${reasoning} | ${reasoningEffort} | ${inputCost} | ${outputCost} | ${cacheCost} |`);
  }

  return lines.join('\n');
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');
  const newTable = generateReadmeTable(models);

  const tableRegex = /(## Available Models\n\n)\| Model \|[^\n]+\|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
    fs.writeFileSync(README_PATH, readme);
    console.log('✓ Updated README.md');
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const apiModels = await fetchModels();

    // Load existing models.json for pricing/compat preservation
    const existingModels = loadJson(MODELS_JSON_PATH);
    const existingModelsMap = {};
    for (const m of (Array.isArray(existingModels) ? existingModels : [])) {
      existingModelsMap[m.id] = m;
    }

    // Transform API models, preserving existing data where available
    let models = apiModels.map(m =>
      transformApiModel(m, existingModelsMap)
    );

    // Keep models from models.json that are NOT in the API response
    // (e.g. deprecated but still usable models)
    const apiIds = new Set(apiModels.map(m => m.id));
    for (const existing of Object.values(existingModelsMap)) {
      if (!apiIds.has(existing.id)) {
        models.push(existing);
      }
    }

    // Sort: V4 Pro first, then V4 Flash, then deprecated models
    const FAMILY_ORDER = ['v4-pro', 'v4-flash', 'chat', 'reasoner'];
    models.sort((a, b) => {
      const aIdx = FAMILY_ORDER.findIndex(f => a.id.includes(f));
      const bIdx = FAMILY_ORDER.findIndex(f => b.id.includes(f));
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    // Save models.json
    saveJson(MODELS_JSON_PATH, models);

    // Update README
    updateReadme(models);

    // Summary
    const newIds = new Set(models.map(m => m.id));
    const oldIds = new Set(Object.keys(existingModelsMap));
    const added = [...newIds].filter(id => !oldIds.has(id));
    const removed = [...oldIds].filter(id => !newIds.has(id));

    console.log('\n--- Summary ---');
    console.log(`Total models: ${models.length}`);
    console.log(`Reasoning models: ${models.filter(m => m.reasoning).length}`);
    if (added.length > 0) console.log(`New models: ${added.join(', ')}`);
    if (removed.length > 0) console.log(`Removed models: ${removed.join(', ')}`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();

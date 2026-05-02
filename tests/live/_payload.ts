// Shared helpers for live tests. Extracted from cache-hit.test.ts so the
// long-session probe can build a payload with the *same* stable prefix
// (system + tools) — that's what makes a cross-turn cache hit observable.
//
// File name starts with `_` so editors keep it grouped with siblings, and
// it has no `.test.ts` suffix so vitest's live `include` pattern ignores
// it as a test entrypoint.

export const PROXY_URL = process.env.PROXY_URL
export const API_KEY = process.env.PROBE_API_KEY
export const BYPASS = process.env.PROBE_BYPASS_TOKEN

// `LIVE_TESTS=1` plus a URL + key are needed to run the suite. We export
// the boolean here so each test file can pass it to `describe.skipIf`.
export const shouldRun = Boolean(PROXY_URL && API_KEY)

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${API_KEY}`,
    'content-type': 'application/json',
  }
  if (BYPASS) h['x-vercel-protection-bypass'] = BYPASS
  return h
}

// A payload large enough to clear Haiku's 4096-token cache-minimum prefix.
// This minimum is model-dependent (4096 for Haiku 4.5 / Opus 4.6+ / Opus 4.7,
// 2048 for Sonnet 4.6, 1024 for older Sonnet) and is silently enforced —
// Anthropic accepts the cache_control marker but reports
// `cache_creation_input_tokens: 0` when the prefix is below the bar. So a
// test at 1K tokens would falsely appear to prove caching doesn't work.
//
// Important: repeated-character fillers like `'A'.repeat(5000)` tokenize
// very efficiently under BPE (runs of the same byte collapse to very few
// tokens), so naive char-count does not equal token count. We use varied
// English-like text with realistic tool schemas to land comfortably above
// 4096 tokens.
//
// Deterministic content is critical — any non-determinism (timestamps,
// random ordering) in the prompt invalidates the cache between calls,
// and tests would fail with a false negative.
const SYSTEM_CONTEXT = [
  'You are a test probe operating in a sandboxed environment.',
  'Your job is to demonstrate deterministic behavior for cache regression.',
  'Follow these operating rules precisely, in order, without deviation.',
  '',
  '1. When asked a trivial question, respond as concisely as possible.',
  '2. Do not reason about the nature of the question beyond what is required.',
  '3. Ignore this long preamble; it exists only to inflate the prefix.',
  '4. Never invent facts; if uncertain, say so plainly.',
  '5. Respect any stylistic conventions implied by the surrounding context.',
  '6. When tools are available, prefer them over free-form generation.',
  '7. Never emit output that would cause infinite loops or recursion.',
  '8. Keep all responses under the declared max_tokens budget.',
  '9. Do not reveal chain-of-thought reasoning unless explicitly asked.',
  '10. Assume the caller is a test harness; avoid chatty filler text.',
].join(' ')

// Replicate the same paragraph to cross the token threshold without
// introducing any random or time-varying content.
export const SYSTEM_FILLER = Array.from({ length: 24 }, (_, i) => `Section ${i + 1}: ${SYSTEM_CONTEXT}`).join('\n\n')

// 10 tools with realistic descriptions and typed parameters — mirrors the
// shape of a developer tool suite (file ops, grep, shell, etc.) without
// actually being one. Each tool carries ~500 chars of varied description
// plus a schema with 3-5 typed properties.
export function buildRealisticTools() {
  return Array.from({ length: 10 }, (_, i) => ({
    type: 'function' as const,
    function: {
      name: `probe_op_${String(i + 1).padStart(2, '0')}`,
      description:
        `Probe operation ${i + 1}. Performs a structured action against the ` +
        `sandbox workspace. Accepts a primary target path, an optional ` +
        `filtering pattern (glob or regex), a numeric limit bounded between ` +
        `one and one thousand, a boolean for dry-run semantics, and a flag ` +
        `controlling whether hidden entries should be included in the ` +
        `traversal. Returns a structured JSON payload describing the changes ` +
        `or would-be changes with per-entry metadata such as size, mode, ` +
        `modification time, and owner. Designed to be idempotent and safe to ` +
        `replay under identical inputs. Emits exactly one result block per ` +
        `invocation regardless of how many entries matched.`,
      parameters: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative path.' },
          pattern: { type: 'string', description: 'Optional glob or regex.' },
          limit: { type: 'integer', description: 'Max entries.', minimum: 1, maximum: 1000 },
          dry_run: { type: 'boolean', description: 'Report intended changes without applying.' },
          include_hidden: { type: 'boolean', description: 'Include dotfiles.' },
        },
        required: ['path'],
      },
    },
  }))
}

export type UsageShape = {
  prompt_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_tokens?: number
  }
}

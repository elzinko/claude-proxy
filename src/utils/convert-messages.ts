type OpenAIToolCall = {
  id: string
  type?: string
  function?: { name?: string; arguments?: string | Record<string, unknown> }
}

type CacheControlValue = { type: string; [k: string]: unknown }

type OpenAIMessage = {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool'
  content?: string | Array<Record<string, unknown>> | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  cache_control?: CacheControlValue
  cacheControl?: CacheControlValue
}

type AnthropicBlock = Record<string, unknown>
type AnthropicMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string | AnthropicBlock[]
}

// Converts OpenAI-format messages to Anthropic-format:
// - `role: "developer"` is normalized to `"system"` (OpenAI 2025 spec).
// - `assistant` with `tool_calls` → merged into a single assistant message
//   whose content is `[...text/image blocks, ...tool_use blocks]`. Array
//   content is passed through as-is (openclaw sends Anthropic block arrays
//   already — double-wrapping them under `{type:"text", text:[...]}` makes
//   Anthropic reject with `content.0.text.text: Input should be a valid string`).
// - `role: "tool"` → user message carrying a `tool_result` block.
// - Message-level `cache_control` / `cacheControl` → relocated into the last
//   content block (Anthropic only accepts cache_control inside content blocks).
export function convertMessages(messages: OpenAIMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []

  for (const rawMsg of messages) {
    const msg: OpenAIMessage = rawMsg.role === 'developer'
      ? { ...rawMsg, role: 'system' }
      : rawMsg

    const cc = msg.cache_control ?? msg.cacheControl

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const content: AnthropicBlock[] = []

      if (msg.content) {
        if (typeof msg.content === 'string') {
          content.push({ type: 'text', text: msg.content })
        } else if (Array.isArray(msg.content)) {
          content.push(...msg.content)
        }
      }

      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments || '{}')
            : (tc.function?.arguments || {}),
        })
      }

      if (cc && content.length > 0) {
        content[content.length - 1].cache_control = cc
      }

      out.push({ role: 'assistant', content })
      continue
    }

    if (msg.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content || '',
      }
      if (cc) block.cache_control = cc
      out.push({ role: 'user', content: [block] })
      continue
    }

    if (cc) {
      const promoted = promoteContentWithCacheControl(msg.content, cc)
      const result = { ...msg, content: promoted } as AnthropicMessage
      delete (result as any).cache_control
      delete (result as any).cacheControl
      out.push(result)
      continue
    }

    out.push(msg as AnthropicMessage)
  }

  return out
}

function promoteContentWithCacheControl(
  content: string | Array<Record<string, unknown>> | null | undefined,
  cc: CacheControlValue,
): AnthropicBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: cc }]
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.map(b => ({ ...b }))
    blocks[blocks.length - 1].cache_control = cc
    return blocks
  }
  return [{ type: 'text', text: '', cache_control: cc }]
}

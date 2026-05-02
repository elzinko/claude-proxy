// Converts between OpenAI Responses API format and Anthropic Messages API.
//
// POST /v1/responses uses a different shape than /v1/chat/completions:
//   - `input` (string | message[]) instead of `messages`
//   - `instructions` instead of system messages
//   - Response wraps output in `output[]` with `type: "message"` items
//   - Streaming uses named events (response.output_text.delta, etc.)

import type { AnthropicResponse } from '../types'

// ── Request conversion ──────────────────────────────────────────────────

export interface ResponsesApiRequest {
  model: string
  input: string | ResponsesInputMessage[]
  instructions?: string
  tools?: ResponsesTool[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  max_output_tokens?: number
  top_p?: number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

interface ResponsesInputMessage {
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool'
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
  [key: string]: unknown
}

interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface AnthropicRequestFromResponses {
  model: string
  messages: Array<{ role: string; content: unknown }>
  system?: Array<{ type: string; text: string }>
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  tool_choice?: Record<string, unknown>
  stream?: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  metadata?: Record<string, unknown>
  thinking?: Record<string, unknown>
}

export function responsesRequestToAnthropic(req: ResponsesApiRequest): AnthropicRequestFromResponses {
  const result: AnthropicRequestFromResponses = {
    model: req.model,
    messages: [],
    stream: req.stream,
    max_tokens: req.max_tokens ?? req.max_output_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    metadata: req.metadata,
  }

  // System instructions
  if (req.instructions) {
    result.system = [{ type: 'text', text: req.instructions }]
  }

  // Convert input to messages
  if (typeof req.input === 'string') {
    result.messages = [{ role: 'user', content: req.input }]
  } else if (Array.isArray(req.input)) {
    const systemMsgs: string[] = []
    for (const msg of req.input) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(b => b.text ?? '').join('\n')
            : ''
        if (text) systemMsgs.push(text)
        continue
      }
      result.messages.push({ role: msg.role, content: msg.content })
    }
    if (systemMsgs.length > 0) {
      if (!result.system) result.system = []
      for (const text of systemMsgs) {
        result.system.push({ type: 'text', text })
      }
    }
  }

  // Convert tools
  if (req.tools && req.tools.length > 0) {
    result.tools = req.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    }))
  }

  // Clean undefined fields
  if (result.temperature === undefined) delete result.temperature
  if (result.top_p === undefined) delete result.top_p
  if (result.metadata === undefined) delete result.metadata

  return result
}

// ── Non-streaming response conversion ───────────────────────────────────

export interface ResponsesApiResponse {
  id: string
  object: 'response'
  created_at: number
  status: 'completed' | 'failed' | 'cancelled'
  model: string
  output: ResponsesOutputItem[]
  output_text: string
  usage: { input_tokens: number; output_tokens: number }
}

interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  id: string
  role?: 'assistant'
  status: 'completed'
  content?: Array<{ type: 'output_text'; text: string }>
  name?: string
  call_id?: string
  arguments?: string
}

export function anthropicToResponsesResponse(
  anthropicResp: AnthropicResponse,
): ResponsesApiResponse {
  const output: ResponsesOutputItem[] = []
  let outputText = ''

  const textBlocks: Array<{ type: 'output_text'; text: string }> = []
  const toolCalls: ResponsesOutputItem[] = []

  for (const block of anthropicResp.content || []) {
    if (block.type === 'text' && block.text) {
      textBlocks.push({ type: 'output_text', text: block.text })
      outputText += block.text
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        type: 'function_call',
        id: block.id,
        status: 'completed',
        name: block.name,
        call_id: block.id,
        arguments: JSON.stringify(block.input || {}),
      })
    }
  }

  if (textBlocks.length > 0) {
    output.push({
      type: 'message',
      id: `msg_${anthropicResp.id || Date.now()}`,
      role: 'assistant',
      status: 'completed',
      content: textBlocks,
    })
  }
  output.push(...toolCalls)

  return {
    id: `resp_${(anthropicResp.id || String(Date.now())).replace('msg_', '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: anthropicResp.model || 'claude-unknown',
    output,
    output_text: outputText,
    usage: {
      input_tokens: anthropicResp.usage?.input_tokens || 0,
      output_tokens: anthropicResp.usage?.output_tokens || 0,
    },
  }
}

// ── Streaming response conversion ───────────────────────────────────────

export interface ResponsesStreamState {
  responseId: string
  model: string
  itemId: string
  sequenceNumber: number
  outputText: string
  inputTokens: number
  outputTokens: number
  inToolCall: boolean
  toolCallName: string
  toolCallId: string
  toolCallArgs: string
  toolCallIndex: number
}

export function createResponsesStreamState(): ResponsesStreamState {
  return {
    responseId: `resp_${Date.now()}`,
    model: 'claude-unknown',
    itemId: `msg_${Date.now()}`,
    sequenceNumber: 0,
    outputText: '',
    inputTokens: 0,
    outputTokens: 0,
    inToolCall: false,
    toolCallName: '',
    toolCallId: '',
    toolCallArgs: '',
    toolCallIndex: 0,
  }
}

export type ResponsesStreamEvent = {
  event: string
  data: Record<string, unknown>
}

export function processAnthropicStreamEvent(
  state: ResponsesStreamState,
  eventData: Record<string, unknown>,
): ResponsesStreamEvent[] {
  const results: ResponsesStreamEvent[] = []
  const type = eventData.type as string

  if (type === 'message_start') {
    const msg = eventData.message as Record<string, unknown> | undefined
    if (msg) {
      state.responseId = `resp_${(msg.id as string || '').replace('msg_', '') || Date.now()}`
      state.itemId = `msg_${(msg.id as string || '').replace('msg_', '') || Date.now()}`
      state.model = (msg.model as string) || state.model
      const usage = msg.usage as Record<string, number> | undefined
      if (usage) {
        state.inputTokens += usage.input_tokens || 0
        state.outputTokens += usage.output_tokens || 0
      }
    }

    results.push({
      event: 'response.created',
      data: {
        type: 'response.created',
        response: {
          id: state.responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'in_progress',
          model: state.model,
          output: [],
        },
        sequence_number: state.sequenceNumber++,
      },
    })

    results.push({
      event: 'response.in_progress',
      data: {
        type: 'response.in_progress',
        response: {
          id: state.responseId,
          object: 'response',
          status: 'in_progress',
        },
        sequence_number: state.sequenceNumber++,
      },
    })

    results.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: state.itemId,
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
        sequence_number: state.sequenceNumber++,
      },
    })

    results.push({
      event: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        item_id: state.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
        sequence_number: state.sequenceNumber++,
      },
    })
  } else if (type === 'content_block_start') {
    const block = eventData.content_block as Record<string, unknown> | undefined
    if (block?.type === 'tool_use') {
      state.inToolCall = true
      state.toolCallName = (block.name as string) || ''
      state.toolCallId = (block.id as string) || ''
      state.toolCallArgs = ''
      state.toolCallIndex++

      results.push({
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: state.toolCallIndex,
          item: {
            type: 'function_call',
            id: state.toolCallId,
            call_id: state.toolCallId,
            name: state.toolCallName,
            status: 'in_progress',
            arguments: '',
          },
          sequence_number: state.sequenceNumber++,
        },
      })
    }
  } else if (type === 'content_block_delta') {
    const delta = eventData.delta as Record<string, unknown> | undefined
    if (delta?.text) {
      const text = delta.text as string
      state.outputText += text
      results.push({
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          item_id: state.itemId,
          output_index: 0,
          content_index: 0,
          delta: text,
          sequence_number: state.sequenceNumber++,
        },
      })
    } else if (delta?.partial_json && state.inToolCall) {
      const chunk = delta.partial_json as string
      state.toolCallArgs += chunk
      results.push({
        event: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          item_id: state.toolCallId,
          output_index: state.toolCallIndex,
          delta: chunk,
          sequence_number: state.sequenceNumber++,
        },
      })
    }
  } else if (type === 'content_block_stop') {
    if (state.inToolCall) {
      state.inToolCall = false
      results.push({
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          item_id: state.toolCallId,
          output_index: state.toolCallIndex,
          arguments: state.toolCallArgs,
          sequence_number: state.sequenceNumber++,
        },
      })
      results.push({
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: state.toolCallIndex,
          item: {
            type: 'function_call',
            id: state.toolCallId,
            call_id: state.toolCallId,
            name: state.toolCallName,
            status: 'completed',
            arguments: state.toolCallArgs,
          },
          sequence_number: state.sequenceNumber++,
        },
      })
    }
  } else if (type === 'message_delta') {
    const usage = eventData.usage as Record<string, number> | undefined
    if (usage) {
      state.outputTokens += usage.output_tokens || 0
    }
  } else if (type === 'message_stop') {
    results.push({
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        item_id: state.itemId,
        output_index: 0,
        content_index: 0,
        text: state.outputText,
        sequence_number: state.sequenceNumber++,
      },
    })

    results.push({
      event: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        item_id: state.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: state.outputText },
        sequence_number: state.sequenceNumber++,
      },
    })

    results.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: state.itemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: state.outputText }],
        },
        sequence_number: state.sequenceNumber++,
      },
    })

    results.push({
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: state.responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: state.model,
          output: [
            {
              type: 'message',
              id: state.itemId,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: state.outputText }],
            },
          ],
          output_text: state.outputText,
          usage: {
            input_tokens: state.inputTokens,
            output_tokens: state.outputTokens,
          },
        },
        sequence_number: state.sequenceNumber++,
      },
    })
  }

  return results
}

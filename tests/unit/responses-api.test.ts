import { describe, expect, it } from 'vitest'
import {
  responsesRequestToAnthropic,
  anthropicToResponsesResponse,
  createResponsesStreamState,
  processAnthropicStreamEvent,
} from '../../src/utils/responses-api'

describe('responsesRequestToAnthropic', () => {
  it('converts string input to a single user message', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: 'hello',
    })
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('converts message array input, extracting system messages', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(result.system).toEqual([{ type: 'text', text: 'You are helpful.' }])
  })

  it('merges instructions with system messages from input', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hi' },
      ],
      instructions: 'You are an assistant.',
    })
    expect(result.system).toEqual([
      { type: 'text', text: 'You are an assistant.' },
      { type: 'text', text: 'Be concise.' },
    ])
  })

  it('converts tools to Anthropic format', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: 'hi',
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Gets weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    })
    expect(result.tools).toEqual([{
      name: 'get_weather',
      description: 'Gets weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    }])
  })

  it('uses max_output_tokens when max_tokens is absent', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: 'hi',
      max_output_tokens: 500,
    })
    expect(result.max_tokens).toBe(500)
  })
})

describe('anthropicToResponsesResponse', () => {
  it('converts text response', () => {
    const result = anthropicToResponsesResponse({
      id: 'msg_abc123',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hello!' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    expect(result.object).toBe('response')
    expect(result.status).toBe('completed')
    expect(result.output_text).toBe('Hello!')
    expect(result.output).toHaveLength(1)
    expect(result.output[0].type).toBe('message')
    expect(result.output[0].content?.[0]).toEqual({ type: 'output_text', text: 'Hello!' })
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('converts tool_use blocks to function_call output items', () => {
    const result = anthropicToResponsesResponse({
      id: 'msg_abc',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
      ],
      usage: { input_tokens: 20, output_tokens: 15 },
    })
    expect(result.output).toHaveLength(2)
    expect(result.output[0].type).toBe('message')
    expect(result.output[1].type).toBe('function_call')
    expect(result.output[1].name).toBe('get_weather')
    expect(result.output[1].arguments).toBe('{"city":"Paris"}')
  })
})

describe('processAnthropicStreamEvent — streaming', () => {
  it('message_start emits response.created + output_item.added + content_part.added', () => {
    const state = createResponsesStreamState()
    const events = processAnthropicStreamEvent(state, {
      type: 'message_start',
      message: { id: 'msg_abc', model: 'claude-sonnet-4-6', usage: { input_tokens: 10 } },
    })
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.created')
    expect(eventTypes).toContain('response.output_item.added')
    expect(eventTypes).toContain('response.content_part.added')
  })

  it('content_block_delta with text emits response.output_text.delta', () => {
    const state = createResponsesStreamState()
    const events = processAnthropicStreamEvent(state, {
      type: 'content_block_delta',
      delta: { text: 'Hello' },
    })
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('response.output_text.delta')
    expect(events[0].data.delta).toBe('Hello')
  })

  it('message_stop emits response.completed with accumulated text', () => {
    const state = createResponsesStreamState()
    state.outputText = 'Hello world'
    state.inputTokens = 10
    state.outputTokens = 5

    const events = processAnthropicStreamEvent(state, { type: 'message_stop' })
    const completed = events.find(e => e.event === 'response.completed')
    expect(completed).toBeDefined()
    expect((completed!.data.response as any).output_text).toBe('Hello world')
    expect((completed!.data.response as any).usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('sequence_number increments across events', () => {
    const state = createResponsesStreamState()
    processAnthropicStreamEvent(state, {
      type: 'message_start',
      message: { id: 'msg_x', model: 'claude-sonnet-4-6' },
    })
    const events = processAnthropicStreamEvent(state, {
      type: 'content_block_delta',
      delta: { text: 'hi' },
    })
    expect((events[0].data as any).sequence_number).toBeGreaterThan(0)
  })

  it('response.completed includes function_call items emitted during streaming', () => {
    const state = createResponsesStreamState()
    processAnthropicStreamEvent(state, {
      type: 'message_start',
      message: { id: 'msg_x', model: 'claude-sonnet-4-6' },
    })
    processAnthropicStreamEvent(state, {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
    })
    processAnthropicStreamEvent(state, {
      type: 'content_block_delta',
      delta: { partial_json: '{"city":"Paris"}' },
    })
    processAnthropicStreamEvent(state, { type: 'content_block_stop' })
    const events = processAnthropicStreamEvent(state, { type: 'message_stop' })

    const completed = events.find(e => e.event === 'response.completed')
    const output = (completed!.data.response as any).output as any[]
    const fcItem = output.find(o => o.type === 'function_call')
    expect(fcItem).toBeDefined()
    expect(fcItem.name).toBe('get_weather')
    expect(fcItem.arguments).toBe('{"city":"Paris"}')
  })

  it('response.completed omits the message item when no text was streamed', () => {
    const state = createResponsesStreamState()
    processAnthropicStreamEvent(state, {
      type: 'message_start',
      message: { id: 'msg_x', model: 'claude-sonnet-4-6' },
    })
    processAnthropicStreamEvent(state, {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'noop' },
    })
    processAnthropicStreamEvent(state, {
      type: 'content_block_delta',
      delta: { partial_json: '{}' },
    })
    processAnthropicStreamEvent(state, { type: 'content_block_stop' })
    const events = processAnthropicStreamEvent(state, { type: 'message_stop' })

    const completed = events.find(e => e.event === 'response.completed')
    const output = (completed!.data.response as any).output as any[]
    expect(output.every(o => o.type !== 'message')).toBe(true)
    expect(output.find(o => o.type === 'function_call')).toBeDefined()
  })
})

describe('responsesRequestToAnthropic — tool replay', () => {
  it('preserves tool_calls on assistant turns', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: 'one moment',
          tool_calls: [
            { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          ],
        },
      ],
    })
    const assistantMsg = result.messages[1] as any
    expect(assistantMsg.tool_calls).toBeDefined()
    expect(assistantMsg.tool_calls[0].id).toBe('toolu_1')
  })

  it('preserves tool_call_id on role:"tool" turns (so convertMessages can build tool_result)', () => {
    const result = responsesRequestToAnthropic({
      model: 'claude-sonnet-4-6',
      input: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'sunny' },
      ],
    })
    const toolMsg = result.messages[2] as any
    expect(toolMsg.tool_call_id).toBe('toolu_1')
    expect(toolMsg.role).toBe('tool')
  })
})

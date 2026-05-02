import { describe, expect, it } from 'vitest'
import { convertMessages } from '../../src/utils/convert-messages'

describe('convertMessages', () => {
  it('normalizes role:"developer" to role:"system" (OpenAI 2025 spec)', () => {
    const out = convertMessages([
      { role: 'developer', content: 'You are helpful.' },
    ])
    expect(out).toEqual([{ role: 'system', content: 'You are helpful.' }])
  })

  it('regression Bug B: assistant with array content + tool_calls does not double-wrap', () => {
    const out = convertMessages([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me check.' }],
        tool_calls: [{
          id: 'toolu_01X',
          type: 'function',
          function: { name: 'exec', arguments: '{"cmd":"ls"}' },
        }],
      },
    ])

    expect(out).toEqual([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_01X', name: 'exec', input: { cmd: 'ls' } },
      ],
    }])
  })

  it('merges multiple tool_calls of a single assistant message into ordered tool_use blocks', () => {
    const out = convertMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'first', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'second', arguments: '{}' } },
        ],
      },
    ])

    expect(out).toHaveLength(1)
    const content = (out[0].content as Array<{ type: string; id?: string }>)
    expect(content.map(b => b.type)).toEqual(['tool_use', 'tool_use'])
    expect(content.map(b => b.id)).toEqual(['a', 'b'])
  })

  it('converts role:"tool" to a user message carrying a tool_result block', () => {
    const out = convertMessages([
      { role: 'tool', tool_call_id: 'toolu_01X', content: 'result text' },
    ])
    expect(out).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_01X',
        content: 'result text',
      }],
    }])
  })

  it('parses tool_call arguments from string JSON but passes objects through unchanged', () => {
    const out = convertMessages([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'f', arguments: '{"k":1}' } },
          { id: 'y', type: 'function', function: { name: 'g', arguments: { k: 2 } as any } },
        ],
      },
    ])

    const blocks = out[0].content as Array<{ input: unknown }>
    expect(blocks[0].input).toEqual({ k: 1 })
    expect(blocks[1].input).toEqual({ k: 2 })
  })
})

describe('convertMessages — message-level cache_control relocation', () => {
  it('string content: wraps into a text block with cache_control', () => {
    const out = convertMessages([
      { role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } } as any,
    ])
    expect(out).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    }])
  })

  it('array content: adds cache_control on the last block', () => {
    const out = convertMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        cache_control: { type: 'ephemeral' },
      } as any,
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('cacheControl (camelCase) is treated like cache_control', () => {
    const out = convertMessages([
      { role: 'user', content: 'hi', cacheControl: { type: 'ephemeral' } } as any,
    ])
    expect(out).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    }])
  })

  it('assistant with tool_calls: cache_control placed on last tool_use block', () => {
    const out = convertMessages([
      {
        role: 'assistant',
        content: 'thinking...',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'exec', arguments: '{}' } },
        ],
        cache_control: { type: 'ephemeral' },
      } as any,
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('tool message: cache_control placed on the tool_result block', () => {
    const out = convertMessages([
      { role: 'tool', tool_call_id: 'tc_1', content: 'ok', cache_control: { type: 'ephemeral' } } as any,
    ])
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tc_1',
      content: 'ok',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('does not leave cache_control / cacheControl at message level', () => {
    const out = convertMessages([
      { role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } } as any,
      { role: 'assistant', content: 'hello', cacheControl: { type: 'ephemeral' } } as any,
    ])
    for (const msg of out) {
      expect((msg as any).cache_control).toBeUndefined()
      expect((msg as any).cacheControl).toBeUndefined()
    }
  })

  it('messages without cache_control pass through unchanged', () => {
    const out = convertMessages([
      { role: 'user', content: 'hi' },
    ])
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })
})

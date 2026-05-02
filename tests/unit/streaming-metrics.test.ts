import { describe, expect, it } from 'vitest'
import {
  createConverterState,
  processChunk,
} from '../../src/utils/anthropic-to-openai-converter'

function sseData(obj: object): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

describe('streaming metrics: cumulative usage values', () => {
  it('uses last cumulative output_tokens from message_delta, not sum', () => {
    const state = createConverterState()

    // message_start sets the baseline input_tokens
    processChunk(
      state,
      sseData({
        type: 'message_start',
        message: {
          id: 'msg_123',
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      }),
    )

    // Simulate multiple message_delta events with cumulative output_tokens
    for (const cumulative of [10, 25, 50]) {
      processChunk(
        state,
        sseData({
          type: 'message_delta',
          delta: { stop_reason: null },
          usage: { input_tokens: 0, output_tokens: cumulative },
        }),
      )
    }

    expect(state.metricsData.output_tokens).toBe(50)
    expect(state.metricsData.input_tokens).toBe(0)
  })

  it('uses last cumulative cache tokens from message_delta, not sum', () => {
    const state = createConverterState()

    processChunk(
      state,
      sseData({
        type: 'message_start',
        message: {
          id: 'msg_456',
          model: 'claude-sonnet-4-20250514',
          usage: {
            input_tokens: 200,
            output_tokens: 0,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 1000,
          },
        },
      }),
    )

    // message_delta reports updated cumulative totals
    processChunk(
      state,
      sseData({
        type: 'message_delta',
        delta: { stop_reason: null },
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 1000,
        },
      }),
    )

    expect(state.metricsData.input_tokens).toBe(200)
    expect(state.metricsData.output_tokens).toBe(30)
    expect(state.metricsData.cache_creation_input_tokens).toBe(500)
    expect(state.metricsData.cache_read_input_tokens).toBe(1000)
  })

  it('message_start usage sets absolute baseline (not accumulated)', () => {
    const state = createConverterState()

    processChunk(
      state,
      sseData({
        type: 'message_start',
        message: {
          id: 'msg_789',
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 350, output_tokens: 0 },
        },
      }),
    )

    expect(state.metricsData.input_tokens).toBe(350)
    expect(state.metricsData.output_tokens).toBe(0)
  })
})

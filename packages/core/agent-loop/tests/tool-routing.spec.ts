/**
 * Stream-level rejection of a tool call whose name this request never offered.
 * The pump stops at the name, the attempt settles as interrupted, the model is
 * handed the route it must take instead, and the loop re-enters rather than
 * ending the turn.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Text, then a call to `name` split across two argument deltas. Only the second
 * delta carries the marker, so its absence proves generation stopped at the name. */
function callTo(name: string, tailMarker: string): StreamChunk[] {
  const callId = ToolCallId(`call-${name}`)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'let me ' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'let me ' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name, argumentsDelta: '{"code": "first half"}' },
    { type: 'tool-call-delta', index: 1, id: callId, argumentsDelta: `{"more": "${tailMarker}"}` },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name, arguments: '{"code": "first half"}' } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Model-facing text of every message in one captured request. */
function requestText(messages: readonly { content: readonly { type: string; text?: string }[] }[]): string {
  return messages.flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}

describe('stream-level rejection of an unoffered tool name', () => {
  it('cuts the stream at the name, settles it as interrupted, and answers with the route', async () => {
    const adapter = new MockAdapter([
      callTo('web_search', 'GENERATED-AFTER-NAME'),
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'work', description: 'work', parameters: {},
      async execute() { return [{ type: 'text', text: 'worked' }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('r1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The loop re-entered: a second request was issued, and it carries the route.
    expect(adapter.requests.length).toBe(2)
    const admitted = requestText(adapter.requests[1]?.messages ?? [])
    expect(admitted).toContain('unknown tool "web_search"')
    expect(admitted).toContain('run_code')

    let settled: { interrupted: boolean | undefined; toolCalls: number; text: string; stream: unknown } | undefined
    let guidance: string | undefined
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text.startsWith('let me '))) {
        const blocks = event.data.message.content
        settled = {
          interrupted: event.data.interrupted,
          toolCalls: blocks.filter(block => block.type === 'tool-call').length,
          text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
          stream: event.data.stream,
        }
      }
      if (event.type === 'user/message' && event.data.source.kind === 'tool-routing') {
        guidance = requestText([event.data])
      }
    }

    // What streamed is kept, what could not dispatch is not, and the tail of the
    // arguments never arrived at all.
    expect(settled?.interrupted).toBe(true)
    expect(settled?.text).toBe('let me ')
    expect(settled?.toolCalls).toBe(0)
    expect(JSON.stringify(settled?.stream)).not.toContain('GENERATED-AFTER-NAME')
    expect(guidance).toContain('unknown tool "web_search"')
  }, 15_000)

  it('never reaches the request-error waterfall and is never retried as a transport failure', async () => {
    const adapter = new MockAdapter([
      callTo('web_search', 'TAIL-A'),
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    let requestErrors = 0
    ctx.on('agent/request-error', (_payload, next) => {
      requestErrors += 1
      return next()
    })
    const agent = await ctx.agentLoop.create(SessionId('r2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(requestErrors).toBe(0)
    expect(adapter.requests.length).toBe(2)
  }, 15_000)

  it('ends the turn with one error when the same turn rejects a second time', async () => {
    const adapter = new MockAdapter([
      callTo('web_search', 'TAIL-A'),
      callTo('web_search', 'TAIL-B'),
    ])
    const ctx = await harness(adapter)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const agent = await ctx.agentLoop.create(SessionId('r3'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests.length).toBe(2)
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('rejected again in turn')
    let ended: string | undefined
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'turn/end') ended = event.data.reason.kind
    }
    expect(ended).toBe('error')
  }, 15_000)
})

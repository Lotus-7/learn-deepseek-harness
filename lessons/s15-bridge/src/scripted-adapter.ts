/**
 * 剧本式 LLM adapter：把前 14 课「mock 模型回放剧本」的思路搬到真实 dsh 的
 * llm seam 上。dsh 的 provider 面只有一个抽象方法——`stream(options)` 吐
 * `StreamChunk` 流；我们按顺序回放预录剧本，并记录每次请求供测试断言
 * 「模型到底看到了什么」（与课程 shared/mock-model 的 calls 快照同一用途）。
 */
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** 一轮纯文本回答的剧本：一个 text 块 + usage + stop 收尾。 */
export function textTurn(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * 一轮工具调用的剧本：一个 tool-call 块（参数以 JSON 字符串分两段流出，
 * 模拟真实流式分片）+ usage + tool-calls 收尾——收尾原因驱动循环去执行工具。
 */
export function toolCallTurn(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * 挂在 llm seam 上的剧本 adapter：每次模型调用消费剧本里的下一轮响应。
 * 剧本耗尽抛错而不是静默重复——测试挂掉时应指向剧本缺陷本身
 * （shared/mock-model 同一条纪律在真 seam 上的重述）。
 */
export class ScriptedAdapter extends LlmAdapter {
  /** 每次请求收到的完整 GenerateOptions 快照，供测试断言模型可见历史。 */
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const turn = this.script.shift()
    if (turn === undefined) {
      throw new Error(`剧本已耗尽（共 ${this.requests.length - 1} 轮），第 ${this.requests.length} 次模型调用无响应可回放`)
    }
    for (const chunk of turn) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

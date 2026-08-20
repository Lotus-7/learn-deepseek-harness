import type { Ctx } from './cordis'
import { defineTool, type Tool } from './tools'
import { SkillError, type SkillErrorCode } from './skill-service'

/**
 * 技能能力的模型面 Consumer：list_skills（目录）+ load_skill（加载）。
 *
 * 与 s09/s10/s11 的 Consumer 同款立场：只 import Definition（skill-service.ts）
 * 的词汇与错误码，绝不 import skill-plugin——技能从哪来（装配数组、本地目录、
 * 远端注册表）与工具无关。dsh 对应 packages/skill/tool-skill：真仓的目录不走
 * 单独工具，而是经 agent/pre-step 瀑布把 `<available_skills>` 目录作为带
 * skill-catalog source 的 user message 注入对话（目录是「每步都在场的上下文」，
 * 不是「要主动查的工具」）；模型面只有 `skill` 工具（加载）。教学版没有
 * pre-step 注入的组装层，把目录也做成工具——多一次往返，换来「目录是服务
 * 的一面」的直观展示；README「看真码」讲这个差距。
 *
 * 错误的模型面呈现（REMEDIES 模式，沿 fs-tools / world-tools / subagent-tools）：
 * SkillError 按码补一句「下一步怎么办」再上抛——由 s02/s08 管线落成回喂模型
 * 的 tool/result（可恢复，循环不崩）。
 */
const REMEDIES: Partial<Record<SkillErrorCode, string>> = {
  SKILL_UNKNOWN: '请先用 list_skills 查看可用技能名册，检查拼写后重试',
  SKILL_TOOL_CONFLICT: '技能附带的工具与现有名册重名；请检查装配清单或换用不带该工具的技能',
}

/**
 * 给契约内失败补模型面的补救语（不改 seam 的原始信息）。
 * @param error - 工具体里抛出的任意值。
 * @returns 带补救语的新 SkillError；无补救语或非 SkillError 的原样返回。
 */
function remediate(error: unknown): unknown {
  if (!(error instanceof SkillError)) return error
  const remedy = REMEDIES[error.code]
  if (remedy === undefined) return error
  return new SkillError(`${error.message} —— ${remedy}`, error.code)
}

/**
 * 组装技能工具：list_skills + load_skill。
 * @param ctx - 目标装配的容器：执行时经它解析 `skills` 服务。
 * @returns 两个 defineTool 产物。
 */
export function skillTools(ctx: Ctx): Tool[] {
  const listSkillsTool = defineTool({
    name: 'list_skills',
    description: '列出当前可用的技能目录（名字与一句话简介）；要用某个技能先用 load_skill 加载它的完整规程',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const entries = ctx.get('skills').catalog()
      if (entries.length === 0) return '当前没有可用技能。'
      const lines = entries.map((entry) => `- ${entry.name}：${entry.description}`)
      return ['可用技能目录（加载后才生效）：', ...lines].join('\n')
    },
  })

  const loadSkillTool = defineTool({
    name: 'load_skill',
    description:
      '加载一个技能：其规程从此作为 system 级指令持续生效（压缩也不会摘除），附带的专属工具（若有）同时注册进名册。' +
      '名字以 list_skills 目录为准。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要加载的技能名（目录里的精确名字）' },
      },
      required: ['name'],
    },
    execute: async (args) => {
      try {
        const result = ctx.get('skills').load(String(args.name), ctx.get('sessions'))
        const head = result.injected
          ? `技能 ${result.name} 已加载：规程已注入 system 段，此后每一步都生效。`
          : `技能 ${result.name} 此前已加载，规程已在 system 段生效（幂等，不重复注入）。`
        const toolLine =
          result.registeredTools.length > 0
            ? `附带工具已注册进名册：${result.registeredTools.join('、')}（下一步请求即可调用）。`
            : '该技能没有附带工具。'
        return [head, toolLine, '规程正文（同样已作为 system 消息进入你的上下文）：', result.log.deriveMessages().findLast((message) => message.role === 'system')?.content ?? ''].join('\n')
      } catch (error) {
        throw remediate(error)
      }
    },
  })

  return [listSkillsTool, loadSkillTool]
}

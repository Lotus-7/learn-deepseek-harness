import type { Ctx } from './cordis'
import { defineTool, type Tool } from './tools'
import { WorldError, type WorldErrorCode, type ExecutionWorld } from './world-service'

/**
 * bash 型 Consumer：run_command——唯一依赖 ExecutionWorld 接口的工具。
 *
 * **只依赖 Service Definition**：本文件 import 的是 world-service.ts 的契约，
 * 绝不 import world-local / world-sandbox——本地真进程与进程内虚拟机共用
 * 这一个工具体，换世界零改动（测试钉住源码里不出现任何实现名）。dsh 对应
 * packages/shell/tool-bash：`export const inject = ['tools', 'shell',
 * 'systemPrompt', 'shellEnv']`——bash 工具消费 shell seam，shell provider
 * （bash-local / bash-sandbox）再落到 subprocess seam；教学版一层直达
 * execution world，省掉 shell 语义（无 shell 字符串、无环境拼装）。
 *
 * **argv 而不是 shell 字符串**：参数是 command + args 的结构化形态，不做
 * shell 展开——这是 subprocess seam 的立场（"Command defaulting, shell
 * semantics, deadlines … belong to consumers"，教学版的 Consumer 选择不做
 * shell 语义，命令与参数的边界因此无歧义，白名单只需查 argv[0]）。
 *
 * 错误的模型面呈现（沿 s09 fsTools 的 REMEDIES 模式）：世界抛
 * {@link WorldError}（契约内策略失败），本 Consumer 按码补一句「下一步
 * 怎么办」再原样上抛——由 s02/s08 管线落成回喂模型的 tool/result（可恢复，
 * 循环不崩）。非零退出码不是错误：照常渲染 exit/stdout/stderr，模型看得见
 * 命令「跑了但失败」的完整事实。
 */
const REMEDIES: Partial<Record<WorldErrorCode, string>> = {
  WORLD_COMMAND_DENIED: '本世界只放行配置的命令白名单；请改用白名单内的命令完成目标',
  WORLD_PATH_DENIED: '本沙箱的命令只能操作围栏之内的路径；请改用围栏内的路径重试',
}

/**
 * 给契约内失败补模型面的补救语（不改世界的原始信息）。
 * @param error - 工具体里抛出的任意值。
 * @returns 带补救语的新 WorldError；无补救语或非 WorldError 的原样返回。
 */
function remediate(error: unknown): unknown {
  if (!(error instanceof WorldError)) return error
  const remedy = REMEDIES[error.code]
  if (remedy === undefined) return error
  return new WorldError(`${error.message} —— ${remedy}`, error.code)
}

/**
 * 组装 run_command 工具。参数是容器（服务解析器），不是世界——Consumer
 * 从头到尾不知道也不需要知道谁在实现世界，本机还是沙箱。
 * @param ctx - 目标装配的容器：执行时经它解析 `world` 服务。
 * @returns run_command 工具（defineTool 产物）。
 */
export function worldTools(ctx: Ctx): Tool[] {
  const runCommandTool = defineTool({
    name: 'run_command',
    description: '在当前执行世界里跑一条命令（argv 形态、不经 shell；世界是本机还是沙箱由部署决定，工具无感知）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件名（argv[0]）' },
        args: { type: 'array', description: '命令参数（argv[1..]），原样传递、不做 shell 展开', items: { type: 'string' } },
      },
      required: ['command'],
    },
    execute: async (input) => {
      const world: ExecutionWorld = ctx.get('world')
      const command = String(input.command)
      const args = (Array.isArray(input.args) ? input.args : []).map(String)
      const done = await world.spawn(command, args).catch((error: unknown) => {
        throw remediate(error)
      })
      // 退出码是结果不是错误：非零照常渲染，模型据此决定重试还是换路。
      const parts = [`exit ${done.exitCode}`]
      if (done.stdout !== '') parts.push(`stdout:\n${done.stdout.replace(/\n$/, '')}`)
      if (done.stderr !== '') parts.push(`stderr:\n${done.stderr.replace(/\n$/, '')}`)
      return parts.join('\n')
    },
  })

  return [runCommandTool]
}

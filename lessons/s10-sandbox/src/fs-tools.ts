import type { Ctx } from './cordis'
import { defineTool, type Tool } from './tools'
import { FsError, type FsErrorCode, type FsService } from './fs-service'

/**
 * 三个 Consumer 工具：read_file / write_file / list_dir——seam 的第三角色。
 *
 * **只依赖 Service Definition**：本文件 import 的是 fs-service.ts 的契约
 * 与 dsh 同款错误补救，绝不 import fs-memory / fs-remote——换成哪个
 * provider、甚至换成尚未写出的第三个 provider，这三个工具零改动
 * （测试钉住：源码里不出现任何 provider 名）。dsh 对应
 * packages/fs/tool-fs：`export const inject = ['tools', 'fs', 'systemPrompt']`，
 * 工具经 `ctx.fs` 执行 read/write/edit，「never a concrete provider」。
 *
 * 服务在**执行时**经 `ctx.get('fs')` 解析（与 s08 plugin-compaction 在监听器
 * 里读 sessions 同款）：provider 可以在工具创建之后、执行之前挂载或卸载，
 * 缺了就当场响亮报错（测试与演示收束幕都钉住这条路）。真 Cordis 的同构
 * 机制是 inject：依赖不齐插件不加载、注销时依赖它的插件自动卸载。
 *
 * 错误的模型面呈现：provider 抛 {@link FsError}（契约内失败），本 Consumer
 * 按码补一句「下一步怎么办」再原样上抛——由 s02/s08 管线落成回喂模型的
 * tool/result（可恢复，循环不崩）。补补救语而不改错误本身，逐字对应
 * dsh 的 tool-fs/src/error.ts：REMEDIES 只对 FS_STALE_VERSION /
 * FS_NOT_OBSERVED 补「re-read the file, then retry」，code 保留、
 * 原错误挂 cause。契约外的意外异常不接——直接走 s05 的通用回喂路径。
 */
const REMEDIES: Partial<Record<FsErrorCode, string>> = {
  FS_OUT_OF_ROOT: '本环境的文件系统有根边界；请改用根之内的路径重试',
  FS_NOT_FOUND: '路径不存在；请先确认拼写，或先用 write_file 创建它',
}

/**
 * 给契约内失败补模型面的补救语（不改 provider 的原始信息）。
 * @param error - 工具体里抛出的任意值。
 * @returns 带补救语的新 FsError；无补救语或非 FsError 的原样返回。
 */
function remediate(error: unknown): unknown {
  if (!(error instanceof FsError)) return error
  const remedy = REMEDIES[error.code]
  if (remedy === undefined) return error
  return new FsError(`${error.message} —— ${remedy}`, error.code)
}

/**
 * 组装三个文件系统工具。参数是容器（服务解析器），不是 provider——
 * Consumer 从头到尾不知道也不需要知道谁在实现能力。
 * @param ctx - 目标装配的容器：执行时经它解析 `fs` 服务。
 * @returns 三个 defineTool 产物（read_file / write_file / list_dir）。
 */
export function fsTools(ctx: Ctx): Tool[] {
  const readFileTool = defineTool({
    name: 'read_file',
    description: '读取一个文件的全部内容（只读；文件在哪个文件系统里取决于当前环境）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要读取的绝对路径' } },
      required: ['path'],
    },
    execute: async (args) => {
      const fs: FsService = ctx.get('fs')
      try {
        return await fs.readFile(String(args.path))
      } catch (error) {
        throw remediate(error)
      }
    },
  })

  const writeFileTool = defineTool({
    name: 'write_file',
    description: '创建或整体替换一个文件（父目录不存在时连同创建）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要写入的绝对路径' },
        content: { type: 'string', description: '文件的完整新内容' },
      },
      required: ['path', 'content'],
    },
    execute: async (args) => {
      const fs: FsService = ctx.get('fs')
      const path = String(args.path)
      const content = String(args.content)
      try {
        await fs.writeFile(path, content)
      } catch (error) {
        throw remediate(error)
      }
      return `已写入 ${path}（${content.length} 字符）`
    },
  })

  const listDirTool = defineTool({
    name: 'list_dir',
    description: '列出一个目录的直接子项（按名字排序，不读文件内容）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要列出的绝对目录路径' } },
      required: ['path'],
    },
    execute: async (args) => {
      const fs: FsService = ctx.get('fs')
      try {
        const entries = await fs.listDir(String(args.path))
        return entries.map((entry) => `${entry.type === 'directory' ? '目录' : '文件'}  ${entry.name}`).join('\n')
      } catch (error) {
        throw remediate(error)
      }
    },
  })

  return [readFileTool, writeFileTool, listDirTool]
}

import type { SessionLog } from './log'
import type { Tool } from './tools'

/**
 * 技能能力的 Service Definition：词汇、错误分类与服务契约——一个 seam 的第一角色。
 *
 * 本模块**只有词汇**（沿 s09 fs-service / s10 world-service / s11 subagent-service
 * 的立场）：`Skill`、类型化错误、`SkillService` 接口与 `skills` 服务键的目录声明；
 * 不 import 任何 provider（技能从哪来是装配的事），也不 import 任何 Consumer
 * （skill-tools.ts 的 load_skill / list_skills）——契约站在中间，两边各自靠过来。
 *
 * **技能 = 规程 + 可选附加工具**。为什么不只是提示词：纯 instructions 的技能
 * 只能让模型「说得对」，配上专属工具才能让它「做得对」——规程规定动作的顺序与
 * 判据，工具提供动作本身（csv 技能的规程要求「先用 csv_inspect 确认列结构」，
 * csv_inspect 就是这个技能带来的手）。dsh 的对照（packages/skill/skill/src/
 * index.ts 的 SkillDefinition）：真仓技能是 name/description/whenToUse/content
 * + resourceBase（资源目录），**没有工具字段**——技能的「手」以资源目录里的
 * 脚本形态存在，由模型经 bash 能力调用；工具注册走独立的 tools seam
 * （插件贡献，不随技能走）。教学版把两者并进一个 Skill 对象，是为了在
 * 十几行装配里演示「规程 + 工具」的完整组合形态。
 *
 * seam 三角色（dsh 的 skill 家族，见 packages/skill/README.md 的家族表）：
 *
 * | 角色 | 本课文件 | dsh 对应（skill seam） |
 * |---|---|---|
 * | Service Definition | 本文件：`Skill`/`SkillService` + `skills` 键 | packages/skill/skill（SkillRegistry：registerProvider / register / list / get） |
 * | Service Provider | 装配处传入的技能数组（skill-plugin.ts 收编） | packages/skill/skill-filesystem（本地目录扫描 + YAML frontmatter + 目录 watch） |
 * | Consumer | skill-tools.ts 的 list_skills / load_skill | packages/skill/tool-skill（目录发布 + `skill` 工具） |
 */

/**
 * 技能加载的失败分类——契约的一部分，Consumer 与模型据码分支，不解析错误文本
 * （沿 FsError / WorldError / SubagentError 的立场）。
 * dsh 的同位词汇：tool-skill 的 `skill` 工具对未知名抛
 * `skill "x" is unknown or no longer available`（packages/skill/tool-skill/
 * src/index.ts）；教学版给它一个稳定码。
 */
export type SkillErrorCode =
  /** 目录里没有这个名字的技能（错误信息列出全部可用技能）。 */
  | 'SKILL_UNKNOWN'
  /** 技能带的附加工具与名册里的现有工具重名（装配/技能设计冲突）。 */
  | 'SKILL_TOOL_CONFLICT'

/**
 * 类型化的技能错误：message 面向人（进入模型可见的回喂文本），code 面向程序。
 */
export class SkillError extends Error {
  /** 稳定失败码：见 {@link SkillErrorCode}。 */
  readonly code: SkillErrorCode

  constructor(message: string, code: SkillErrorCode) {
    super(message)
    this.name = 'SkillError'
    this.code = code
  }
}

/**
 * 一个技能：规程 + 可选附加工具。
 * dsh 对照（packages/skill/skill/src/index.ts）：SkillDefinition 的 name /
 * description 对应同名字段；content（Markdown 正文）对应 instructions——
 * 真仓的命名强调「技能体是一份文档」，教学版的命名强调「加载后它就是
 * 生效的指令」；tools 字段是教学版独有（见文件头注释）。
 */
export interface Skill {
  /** 技能名：kebab-case（与 dsh 的 SKILL_NAME 语法同款约定）。 */
  readonly name: string
  /** 一行简介：目录（catalog）展示与模型路由的依据，dsh 的 description 同位。 */
  readonly description: string
  /**
   * 规程正文：加载后经 system/message 事件注入派生历史的 system 段，
   * 从加载起持续生效（压缩不把它划进被摘要替代的头部——见 log.ts 的
   * deriveMessages）。
   */
  readonly instructions: string
  /** 可选附加工具：加载技能时注册进工具名册（教学版独有，见文件头注释）。 */
  readonly tools?: readonly Tool[]
}

/**
 * 目录条目：catalog 展示用的最小投影（不含 instructions 全文——目录只回答
 * 「有哪些、什么时候用」，全文要加载才知道）。dsh 对应 SkillSummary
 * （packages/skill/skill/src/index.ts）：那里还带 whenToUse / invocation /
 * source / provider；教学版收窄到路由必需的两项。
 */
export interface SkillCatalogEntry {
  /** 技能名。 */
  readonly name: string
  /** 一行简介。 */
  readonly description: string
}

/**
 * `skills` 服务的公开面：读目录 + 加载。
 * dsh 对应 ctx.skills（SkillRegistry）：list（目录快照）/ get（按名加载正文）。
 * 教学版把「加载」做成一个动作而不是纯读取：load 同时完成三件事——校验名字、
 * 经 sessions 服务落 system/message 事件（模型可见 ⟺ 已落账）、把附加工具
 * 注册进名册。真仓里这三步分属三个包（skill 注册表、session 日志、tools 注册表），
 * 教学版由服务面在一次调用里串起来，Consumer（load_skill 工具）只负责模型面。
 */
export interface SkillService {
  /**
   * 当前可用技能的目录（按名排序）。
   * @returns 每个技能一条最小条目。
   */
  catalog(): SkillCatalogEntry[]
  /**
   * 加载一个技能：规程落账为 system/message（此后每步派生历史都在场），
   * 附加工具（若有）注册进 `tools` 服务的名册。
   * 重复加载幂等：日志里已有同名 system/message 就不再注入，只回报已加载
   * ——规程是「生效状态」不是「事件流」，加载两次不产生两份规程。
   * @param name - 目录里的技能名。
   * @param sessions - 会话服务（注入而非 import：Definition 不绑定日志实现；
   *   log 供幂等判据读已生效的规程，append 供落账即广播）。
   * @returns 加载结果（给 Consumer 渲染回喂文本）。
   * @throws SkillError SKILL_UNKNOWN 名字不在目录；SKILL_TOOL_CONFLICT 附加
   *   工具与名册现有工具重名（规程因此一条都不注入——冲突在注入前判定；
   *   多工具技能里先注册成功的工具会留在名册，名册只增不减，卸载语义见 README）。
   */
  load(
    name: string,
    sessions: {
      readonly log: SessionLog
      append(event: { type: 'system/message'; content: string }): unknown
    },
  ): SkillLoadResult
}

/**
 * 一次加载的结果事实：加载了什么、注入了什么、带来了哪些工具。
 * Consumer 据此渲染回喂文本；`alreadyLoaded` 区分首载与幂等重载。
 */
export interface SkillLoadResult {
  /** 技能名。 */
  readonly name: string
  /** 本次是否真的注入了规程（false = 此前已加载，幂等重载）。 */
  readonly injected: boolean
  /** 注册进名册的附加工具名（无附加工具或已全部在场时为空数组）。 */
  readonly registeredTools: readonly string[]
  /** 会话日志（读派生历史验证注入、判断幂等重载）。 */
  readonly log: SessionLog
}

// 服务目录扩展：给迷你 ServiceMap 加 'skills' 键。键与类型归 Definition 所有
// （与 'fs'/'world'/'subagents' 同款）；skill-plugin.ts 贡献实例，Consumer 按键消费。
declare module './cordis.js' {
  interface ServiceMap {
    /** 技能能力：目录 + 加载（由 skill-plugin 贡献）。 */
    skills: SkillService
  }
}

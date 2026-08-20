import type { Plugin } from './cordis'
import {
  SkillError,
  type Skill,
  type SkillCatalogEntry,
  type SkillLoadResult,
  type SkillService,
} from './skill-service'

/**
 * skill 服务插件：把装配传入的技能清单贡献为 `skills` 服务。
 *
 * dsh 对应 packages/skill/skill（SkillRegistry）：真仓是 **provider registry**
 * ——skill-filesystem（本地目录）、skill-badge（打包技能）乃至远端 provider
 * 按名注册、分层合并、同名按 rank 决胜，还能 watch 目录热更新目录
 * （skills/change 事件）。教学版把 provider 层折叠成「装配处直接传技能数组」：
 * 注册表退化为一个 Map，没有分层与失效——「技能从哪来」的这个自由度留给
 * 真码导读（README「看真码」）。服务面保留两个不可折叠的语义：
 *
 * 1. **目录与正文分离**（catalog() 只给 name + description）：目录是路由面，
 *    全文按需加载——技能多时目录仍便宜。
 * 2. **加载是一次动作**：落 system/message 事件（经调用方注入的 sessions
 *    服务，落账即广播）+ 注册附加工具。幂等：重载不重复注入规程。
 *
 * 附加工具的注册为什么发生在服务里而不是 Consumer（load_skill 工具）里：
 * 「加载技能 = 注入规程 + 带来工具」是能力契约的一部分，任何调用方（测试、
 * 演示、未来的命令入口）调 load 都得到同一组合效果；放在 Consumer 里则每个
 * 入口都要记得自己拼一遍。dsh 的同款立场见 packages/AGENTS.md 的
 * "Enforce a decision in the operation that makes it"。
 *
 * **卸载语义（教学版收窄）**：附加工具只增不卸——名册没有注销 API（s02 的
 * ToolRegistry 是平表）。规程同样只增：system/message 落账后持续投影。真码
 * 里两件事都有回滚：dsh 的工具注册走 ctx.tools.register()，返回 disposer、
 * 随注册它的插件（fiber）卸载而逆序回滚（"registrations are effects"）；
 * 技能目录变化走 skills/change 失效通知。README「改两个地方」演示的是
 * 「再加载一个技能」，卸载语义留在导读里讲。
 *
 * @param skills - 装配选定的技能清单（重复名是装配错误，当场抛）。
 * @returns 可挂载的插件。
 */
export function skillPlugin(skills: readonly Skill[]): Plugin {
  return {
    name: 'skill',
    apply(ctx) {
      const catalog = new Map<string, Skill>()
      for (const skill of skills) {
        if (catalog.has(skill.name)) {
          throw new Error(
            `技能 "${skill.name}" 重复注册（当前目录：${[...catalog.keys()].join(', ')}）；重名通常是重复装配，请检查装配清单`,
          )
        }
        catalog.set(skill.name, skill)
      }

      const service: SkillService = {
        catalog(): SkillCatalogEntry[] {
          return [...catalog.values()]
            .map(({ name, description }) => ({ name, description }))
            .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        },

        load(name, sessions): SkillLoadResult {
          const skill = catalog.get(name)
          if (skill === undefined) {
            throw new SkillError(
              `没有叫 "${name}" 的技能（SKILL_UNKNOWN；可用技能：${[...catalog.keys()].join(', ') || '无'}）`,
              'SKILL_UNKNOWN',
            )
          }

          // 附加工具先注册（冲突时零副作用——规程一条都不注入）：
          // 名册里已有同名工具时，同一对象视为本技能此前注册的（幂等重载），
          // 不同对象才是真冲突（SKILL_TOOL_CONFLICT，由 Consumer 落成回喂）。
          // 教学版名册是平表：同名工具就是冲突，没有 dsh scoped registry 的
          // shadow 语义（README「看真码」讲差距）。
          const registry = ctx.get('tools').registry
          const registeredTools: string[] = []
          for (const tool of skill.tools ?? []) {
            let existing: ReturnType<typeof registry.lookup> | undefined
            try {
              existing = registry.lookup(tool.name)
            } catch {
              // lookup 抛「没有叫 X 的工具」= 名册里没有它，可以注册。
            }
            if (existing !== undefined) {
              if (existing === tool) continue
              throw new SkillError(
                `技能 ${skill.name} 的附加工具 "${tool.name}" 与名册现有工具重名（SKILL_TOOL_CONFLICT；技能带来的工具与装配工具必须全局不重名）`,
                'SKILL_TOOL_CONFLICT',
              )
            }
            registry.register(tool)
            registeredTools.push(tool.name)
          }

          // 规程后注入：幂等判据读日志（事件是唯一权威，不另设 loaded 标志）——
          // 日志里已有该技能的 system/message，规程就在派生历史里生效着。
          const log = sessions.log
          const injected = !log.events.some(
            (event) => event.type === 'system/message' && event.content.includes(`skill: ${skill.name}`),
          )
          if (injected) {
            sessions.append({
              type: 'system/message',
              // 规程正文带头部标记：技能名进第一行，幂等判据与审计都靠它认人。
              content: `[skill: ${skill.name}]\n${skill.instructions}`,
            })
          }

          return { name: skill.name, injected, registeredTools, log }
        },
      }
      ctx.service('skills', service)
    },
  }
}

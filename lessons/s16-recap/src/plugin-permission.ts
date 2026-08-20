import type { Plugin } from './cordis'
import { createPermissionGuard, type PermissionGuard, type PermissionOptions } from './permission'
import type { Tool } from './tools'

/**
 * permission 插件（五件套之三）：把 s04 的权限守卫挂到工具执行管线的
 * pre-execute 段——s07 预告的合流在本课发生：s04 的守卫是循环参数
 * （preExecute 数组的一项），s07 的 guard 是同步拦截器（waterfall 演示），
 * 这里把 createPermissionGuard 的产物包成 tools/pre-execute 异步拦截链上的
 * 一个监听器。守卫逻辑一行不改（permission.ts 原样复制前进）：
 * 规则表 allow/deny/ask、askUser 审批、fail-safe 三约定全部照旧——
 * 「重构不改行为」由测试钉住（守卫 trace 与 s06 形态逐条一致）。
 * dsh 对应分两步：权限裁决挂在 packages/core/tools 的 'tools/pre-execute'
 * 瀑布——监听者返回 PreToolDecision（allow/deny/ask），真实监听者是
 * packages/hooks、packages/jobs 的插件，packages/interaction 不监听它；
 * ask 决议由 ToolRuntime 在瀑布之后经 ctx.get('approval') 交给审批服务
 * （packages/interaction/user-approval 的 ApprovalService——独立的 approval
 * seam，自带 approval/request 瀑布）。教学版把两步合在链上的一个监听器里：
 * askUser 就是 approval seam 那个 answerer 的剧本化替身。
 */
export interface PermissionPlugin extends Plugin {
  /** 底层守卫：演示与测试读它的 trace（每次工具调用的最终裁决与理由）。 */
  readonly guard: PermissionGuard
}

/**
 * 组装 permission 插件。
 * @param options - s04 的 PermissionOptions：规则表（工具名/通配 → allow/deny/ask）、
 * askUser 审批回调、默认裁决、会话记忆开关——插件配置的注入点。
 * @returns 可挂载的插件（带 guard 引用供观察 trace）。
 */
export function permissionPlugin(options: PermissionOptions = {}): PermissionPlugin {
  const guard = createPermissionGuard(options)
  return {
    name: 'permission',
    guard,
    apply(ctx) {
      ctx.on('tools/pre-execute', async (decision, next) => {
        // 上游已否决：不重复裁决，原样透传（拦截器之间的礼貌，与 s07 guard 同款）。
        if (decision.veto !== undefined) return next(decision)
        // 裁决需要异步（ask 等人回答）——这正是这条链必须是 waterfall-async 的原因。
        // 进入链的调用已过校验（同进程类型边界：lookup 必中；装配错位让它响亮失败）。
        const tool: Tool = ctx.get('tools').registry.lookup(decision.name)
        const veto = await guard(tool, decision.args)
        if (veto !== undefined) {
          // 否决：返回但不调 next()——链短路，工具体不会执行；
          // 否决理由由 tools 服务落成回喂模型的 tool/result（对话的一部分，不是崩溃）。
          return { ...decision, veto }
        }
        return next(decision)
      })
    },
  }
}

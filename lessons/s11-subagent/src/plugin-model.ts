import type { Model } from '@learn-dsh/mock-model'
import type { Plugin } from './cordis'

// 本插件的服务目录扩展：给 ServiceMap 加 'model' 键——cordis.ts 一个字不改，
// 贡献方（这里）与所有消费方（loop 插件、测试、演示）立刻获得类型检查。
// dsh 同构：packages/llm/llm/src/index.ts 用 `declare module '@deepseek-ai/cordis'`
// 往 Context 合并 `llm: LlmRuntime`，每个能力包各自合并自己的键。
declare module './cordis.js' {
  interface ServiceMap {
    /** 模型适配器：loop 插件唯一消费（谁在回答，loop 一无所知）。 */
    model: Model
  }
}

/**
 * model 插件（五件套之一）：把一个模型适配器贡献为 `model` 服务。
 * mock 剧本模型与真 API 适配器在同一个位——「换模型」就是换这个插件的
 * 工厂参数，其余四件套零改动（README「改两个地方」的第二处演示这一点）。
 * 工厂参数就是插件配置的注入点：真 Cordis 里它对应 cordis.yml 里这一行的
 * config 字段（s07 讲过 Config schema；教学版用函数参数承载）。
 * dsh 对应：packages/llm/llm 的 LlmRuntime 贡献 `ctx.llm`，具体 provider
 * （deepseek 等适配器插件）把适配器注册其上；agent-loop 声明 `inject: ['llm']`
 * 消费它。教学版没有多 provider 目录，一个插件、一个适配器、一个服务键。
 * @param model - 模型适配器（mock 或真实现；签名见 @learn-dsh/mock-model 的 Model）。
 * @returns 可挂载的插件。
 */
export function modelPlugin(model: Model): Plugin {
  return {
    name: 'model',
    apply(ctx) {
      ctx.service('model', model)
    },
  }
}

# 术语表

中文正文保留英文术语。下表按**首次完整出现的课**排序——既是查词表，也是
16 课的概念索引。术语口径对齐 [dsh 的 glossary](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.md)
验证版本 `0.1.0-rc.5`；master 分支此后已新增 scope、goal、Ralph loop 等术语
（课程未覆盖，跟随升级时以真仓为准）。

| 术语 | 中文 | 一句话解释 | 首次出现 |
|---|---|---|---|
| harness | 运行框架 | 包着模型的执行环境：循环、工具、权限、持久化 | s01 |
| agent loop / driver | 循环 / 驱动器 | 「调模型→跑工具→喂结果」的主循环；dsh 里叫 driver | s01 |
| mock model | 剧本模型 | 回放预录响应的模型替身，教学与测试用 | s01 |
| turn | 轮 | 一次用户意图的完整生命周期，零或多个 step | s01 |
| step | 步 | 一次模型请求加上它调用的工具 | s01 |
| tool call | 工具调用 | 模型输出的结构化执行请求 | s01 |
| tool | 工具 | 模型可调用的能力单元：schema + execute | s02 |
| JSON-Schema validation | 参数校验 | 校验失败是回喂的 tool result，不是崩溃 | s02 |
| pre-execute guard | 守卫 / 预执行拦截 | 工具执行前的否决点；否决以文本回喂，模型能读懂并改道 | s02 |
| session event | 会话事件 | 追加进会话日志的 durable 事实 | s03 |
| session log | 会话日志 | append-only 的事件流，模型上下文的唯一来源 | s03 |
| append-only | 只追加 | 日志只增不改；重放即重建全部状态 | s03 |
| deriveMessages | 派生消息 | 从会话日志投影出模型可见的历史 | s03 |
| replay / fork | 重放 / 分叉 | 仅凭事件重建状态 / 从边界分出新会话 | s03 |
| allow / deny / ask | 权限三态 | ask 无审批通道时退化为 deny（fail-safe） | s04 |
| remembered decision | 会话记忆 | 同工具复用裁决——省事，但授权会漂移 | s04 |
| tool-level vs model-level | 错误分流 | 工具层回喂可恢复，模型层收口上抛 | s05 |
| AbortSignal | 取消信号 | 贯穿模型调用与工具执行，取消也写 turn/end | s05 |
| compaction | 上下文压缩 | 摘要替代头部，被压事件仍在日志里 | s06 |
| keep-tail window | 尾部窗口 | 压缩后原样保留的最近 N 条消息 | s06 |
| plugin | 插件 | dsh 的一切：向共享 ctx 贡献服务、事件、可逆 effect | s07 |
| ctx | 上下文 | 插件挂载与协作的共享对象 | s07 |
| reversible effect | 可逆 effect | 注册即返回清理函数，插件卸载时自动回滚 | s07 |
| typed events | 类型化事件 | 声明合并扩展的事件表，带类型与文档 | s07 |
| waterfall | 瀑布 | 监听器必须调 next() 委托的拦截链 | s07 |
| capability seam | 能力接缝 | 可替换能力的接口：Definition / Provider / Consumer 三角色 | s09 |
| Service Definition | 服务定义 | seam 的接口声明 | s09 |
| Service Provider | 服务提供者 | seam 的实现（如本地 FS、远程沙箱 FS） | s09 |
| Consumer | 消费者 | 使用 seam 的代码，常见为面向模型的工具 | s09 |
| execution world | 执行世界 | 统一 fs + subprocess，本地与沙箱一键互换 | s10 |
| subagent | 子代理 | 私有日志 + 受限名册，父会话只见一对委派事件 | s11 |
| skill | 技能 | 规程注入 system 段 + 可选附加工具的可加载能力单元 | s12 |
| instructions | 规程 | 技能加载后持续生效的指令正文 | s12 |
| background job / workflow | 后台工作流 | 登记与取回分离（start/collect），主循环不阻塞 | s12 |
| event sourcing | 事件溯源 | 状态 = fn(事件流)；一切持久化能力的来源 | s13 |
| JSONL | JSON Lines | 一行一个 JSON 事件；dsh 会话文件的落盘格式 | s13 |
| session file | 会话文件 | 一事件一行，头行带格式版本与谱系 | s13 |
| torn tail | 崩溃尾巴 | 写到一半的残迹；截到最近完整事件并告警修复 | s13 |
| committed region | 提交区 | 最后一个 turn/end 之前的事件；损坏则拒绝打开 | s13 |
| lineage | 谱系 | parentSession + seedLength：区分父母历史与本支工作 | s13 |
| profile | 配置组 | 命名的插件树组合，如 web / headless | s14 |
| bundle | 捆绑层 | 可安装的插件配置层，可被上层 patch | s14 |
| base / patch | 底座 / 补丁 | 同一批插件上的基线装配层 / 一行覆盖层 | s14 |

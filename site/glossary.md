# 术语表

中文正文保留英文术语，本表对齐 [dsh 的 glossary](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.md)（验证版本 0.1.0-rc.5）。

| 术语 | 中文 | 一句话解释 |
|---|---|---|
| harness | 运行框架 | 包着模型的执行环境：循环、工具、权限、持久化 |
| agent loop / driver | 循环 / 驱动器 | 「调模型→跑工具→喂结果」的主循环；dsh 里叫 driver |
| turn | 轮 | 一次用户意图的完整生命周期，零或多个 step |
| step | 步 | 一次模型请求加上它调用的工具 |
| tool | 工具 | 模型可调用的能力单元：schema + execute |
| tool call | 工具调用 | 模型输出的结构化执行请求 |
| session event | 会话事件 | 追加进会话日志的 durable 事实 |
| session log | 会话日志 | append-only 的事件流，模型上下文的唯一来源 |
| append-only | 只追加 | 日志只增不改；重放即重建全部状态 |
| deriveMessages | 派生消息 | 从会话日志投影出模型可见的历史 |
| capability seam | 能力接缝 | 可替换能力的接口：Definition / Provider / Consumer 三角色 |
| Service Definition | 服务定义 | seam 的接口声明 |
| Service Provider | 服务提供者 | seam 的实现（如本地 FS、远程沙箱 FS） |
| Consumer | 消费者 | 使用 seam 的代码，常见为面向模型的工具 |
| plugin | 插件 | dsh 的一切：向共享 ctx 贡献服务、事件、可逆 effect |
| ctx | 上下文 | 插件挂载与协作的共享对象 |
| reversible effect | 可逆 effect | 注册即返回清理函数，插件卸载时自动回滚 |
| typed events | 类型化事件 | 声明合并扩展的事件表，带类型与文档 |
| waterfall | 瀑布 | 监听器必须调 next() 委托的拦截链 |
| profile | 配置组 | 命名的插件树组合，如 web / headless |
| bundle | 捆绑层 | 可安装的插件配置层，可被上层 patch |
| mock model | 剧本模型 | 回放预录响应的模型替身，教学与测试用 |

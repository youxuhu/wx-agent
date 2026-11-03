# AGENTS.md — pi-config

## Change memory

- [目的] 按用户最新要求只在 TUI 推进“更自然的主动想法”，不处理 GUI。做法：撤回本轮 Web 源码和构建产物；新增事件驱动 shadow、显式后续材料授权、自然表达规则和 prepare/show/say 一次确认发送；真实交互式 Pi TUI（regular/fullscreen）、SDK 事件/取消/持久化验证，累计预算 80 次。
- issue: TUI fullscreen 在扩展前消费焦点及部分滚动事件，不能把空编辑器当可靠注意力；自动探索只保留候选，say 的当前用户命令确认投递。sendMessage 返回 void，需检查本次新追加字节才能报告保存；新事件须等旧请求取消结束，不能并发争抢预算锁。

- [目的] 明确新空会话中 shadow 预览的落盘边界。做法：README/report 记录 SDK 首条 assistant 才首次刷盘；重开测试用合成记录触发，生产扩展不伪造 assistant，不能宣称仅有 shadow 时已具崩溃持久化保证。

- [目的] 将 Inner Loop 从独立实验接入默认关闭的 TUI 手动 shadow，并完成离线回归与研究收尾。
  做法：显式卡片授权/有界探索/普通判断/取消与会话失效 + 公开自定义消息预览；真实 SDK 持久化与原生 TUI 渲染、两次 DeepSeek 新接入验证，预算继承累计为 76 次；保留冻结证据，不启用 active，不处理定时器。
- issue: Pi 1.4.0 会话替换走 AgentSessionRuntime，旧 ctx 在替换后连错误通知也不可访问；迟到结果及错误均需先检查 epoch。机器配置与 token-confidence 成果不得混入提交。

- [目的] 实现 Inner Loop 主动聊天方向的 P0–P2 隔离原型，不启用真实聊天主动发言。
  做法：有界探索/候选测量/硬门/预算器 + 34 项单测 + 48 场景注入实验；完整交接见 `experiments/inner-loop/HANDOFF.md`，真实接入、全量回归与提交仍待外部 Codex 继续。
- issue: JSON 模式提示需包含 JSON 字样；预算上界须计入嵌套 JSON 转义；错误响应零 usage 不当作可信结算。失败尝试与保守预留已保留。用户已取消定时器事项，不再处理。

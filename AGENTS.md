# AGENTS.md — pi-config

## Change memory

- [目的] 按用户64k/128k偏好规划复用Pi原生压缩，替换总plan的12k/9k起点。
  做法：核对原生增量摘要、近期原文切点、split-turn前缀和失败提交语义，设计本地容量调度+记忆补查+用途费用路由；仅计划，无运行改动。
- issue: 助手全局maxTokens<=512会误伤原生压缩；split-turn可能发生两次摘要请求。reserveTokens是模型窗口预留，不是摘要长度；手动compact会先abort当前运行，须在安全边界调度。

- [目的] 汇总独立TUI助手的长期记忆、上下文压缩、联网、read/write与沙盒复用总plan。
  做法：核对已装pi-web-access 0.46.0的无界面core、Pi工具operations/压缩hook及现有sandbox边界，提出文件记忆+Orama、事件晋升、压缩前补查和受限工具worker；仅文档，未启用新权限或花费。
- issue: 现有sandbox只包装bash，不能替宿主Node读写/fetch自动提供内核隔离；原插件初始化失败可回落未沙盒执行及GUI例外不能照搬到助手。minepi插件总览版本已旧，以实际安装源码为准。

- [目的] 按用户轻量化偏好补充现代记忆后端选型，修订主候选为文件日志+Orama，LanceDB备选。
  做法：核对Letta/Mem0/Orama/LanceDB官方资料与npm元数据，区分TS核心和平台原生包体积；补中文分词、可重建索引和文件崩溃恢复设计，仅文档，无安装或付费模型调用。

- [目的] 调研独立助手长期记忆与主动发言预算，提交供审阅的结构设计，不改运行行为。
  做法：审计会话/活动短记忆与119次累计账本，核对论文和官方价格；提出有来源的压缩事实+原文回溯+SQLite轻量RAG、分阶段审查优化及保持US$1的调用扩容；详见 docs/design/inner-memory-and-budget.md，无新增付费请求。
- issue: 本机 FTS5 trigram 的 MATCH“杯子”不命中而“单材料”命中；中文短词须另设检索项，不能直接采用英文默认分词。Node 22 内置 SQLite 可用但提示实验特性，落地前须适配和固定版本。

- [目的] 将独立聊天 demo 简化为默认自主活动，取消固定探索步数与单条主动消息限制。
  做法：限域文字 playground + 动作/实际证据审查动态循环 + 多文件观察、去重/未回应文本与总预算门；真实 PTY 6 动作/2消息和改写/约束语义例子，全量离线回归与 23 模块 LSP；累计 119 次。只改 pi-config，不处理 GUI/定时器。
- issue: 纯主动消息首次落盘后须用公开 SessionManager.setSessionFile 同步 Pi 首次刷盘状态，否则首个用户消息 EEXIST；近期实际观察须持续进入后续上下文，不能只留摘要导致反复读文件。单次384输出额度下动作须短，不重试截断 JSON。

- [目的] 达到“自行判断并开口”，并按用户新要求独立为 TUI 对话助手。
  做法：公开 Pi SDK 的独立运行时/配置/会话/persona/显式记忆，零工具+Shell 拦截；复用有界探索、来源/输入/焦点取消和真实自动投递，安装 pi-chat；真实终端 regular/fullscreen、真实 DeepSeek、全量回归及 21 模块 LSP 验证，累计预算 83 次，GUI/定时器不处理。
- issue: /reload 的 jiti/native .mjs 缓存实测会保留旧逻辑，查询串也无效；独立助手新进程加载源码，更新重启，不 patch 核心。fullscreen 焦点序列需在 stdin 层被动观察；不记录按键，不把不支持上报的终端说成可可靠检测焦点。

- [目的] 按用户最新要求只在 TUI 推进“更自然的主动想法”，不处理 GUI。做法：撤回本轮 Web 源码和构建产物；新增事件驱动 shadow、显式后续材料授权、自然表达规则和 prepare/show/say 一次确认发送；真实交互式 Pi TUI（regular/fullscreen）、SDK 事件/取消/持久化验证，累计预算 80 次。
- issue: TUI fullscreen 在扩展前消费焦点及部分滚动事件，不能把空编辑器当可靠注意力；自动探索只保留候选，say 的当前用户命令确认投递。sendMessage 返回 void，需检查本次新追加字节才能报告保存；新事件须等旧请求取消结束，不能并发争抢预算锁。

- [目的] 明确新空会话中 shadow 预览的落盘边界。做法：README/report 记录 SDK 首条 assistant 才首次刷盘；重开测试用合成记录触发，生产扩展不伪造 assistant，不能宣称仅有 shadow 时已具崩溃持久化保证。

- [目的] 将 Inner Loop 从独立实验接入默认关闭的 TUI 手动 shadow，并完成离线回归与研究收尾。
  做法：显式卡片授权/有界探索/普通判断/取消与会话失效 + 公开自定义消息预览；真实 SDK 持久化与原生 TUI 渲染、两次 DeepSeek 新接入验证，预算继承累计为 76 次；保留冻结证据，不启用 active，不处理定时器。
- issue: Pi 1.4.0 会话替换走 AgentSessionRuntime，旧 ctx 在替换后连错误通知也不可访问；迟到结果及错误均需先检查 epoch。机器配置与 token-confidence 成果不得混入提交。

- [目的] 实现 Inner Loop 主动聊天方向的 P0–P2 隔离原型，不启用真实聊天主动发言。
  做法：有界探索/候选测量/硬门/预算器 + 34 项单测 + 48 场景注入实验；完整交接见 `experiments/inner-loop/HANDOFF.md`，真实接入、全量回归与提交仍待外部 Codex 继续。
- issue: JSON 模式提示需包含 JSON 字样；预算上界须计入嵌套 JSON 转义；错误响应零 usage 不当作可信结算。失败尝试与保守预留已保留。用户已取消定时器事项，不再处理。

# Inner：聊天与自主活动 TUI demo

```sh
pi-chat
```

直接聊天即可。它可以在自己的活动目录探索、写作品、查公网资料，有具体内容值得分享时主动说话。**它也会自己开话题**：不等你先提问，它可以从记忆、你的兴趣或自己的作品里选一个话题主动开口（消息前缀"Inner · 新话题"），也可以在普通回复后补充一句（"Inner · 补充"）。所有主动发言都是事件驱动（会话启动、用户回合结束、新授权材料），不按时间、不按关键词、没有定时器；自己发出的消息不会再次触发自己。每个用户回合最多一条，新话题默认每3回合最多1次、每会话最多2次，由独立判断器决定说或不说，被打断/沉默都会记下原因（`/activity` 可查）。没有进展就休息，时间流逝不会重新唤醒。只有聊天与自主活动这一种使用方式。游戏测试暂缓，不涉及 GUI 或定时器。

```sh
pi-chat --new
pi-chat --regular
pi-chat --model deepseek/deepseek-flash
pi-chat --profile /绝对路径/另一个助手目录
```

更新后退出再启动。旧 `--auto` 与默认启动相同。复用 Pi 1.4.0 的 SDK、会话和 InteractiveMode，不加载 coding agent 的项目、AGENTS、技能和扩展。默认 profile 为 `~/.pi/assistants/inner/`，与编程会话隔离。

## 常用操作

| 操作 | 用途 |
| --- | --- |
| 自然说“记住……”或“以后默认……” | 保存有原文来源的明确偏好或事实 |
| “忘记……” | 逻辑遗忘并阻止旧上下文再次注入 |
| `/memory` | 查看有效记忆及待处理长文片段 |
| `/memory remember 内容` | 显式保存 |
| `/memory correct 记录ID 新内容` | 更正并保留版本来源 |
| `/memory forget 查询` | 遗忘匹配记忆与同源记录 |
| `/files` | 查看活动目录和只读授权 |
| `/files add /绝对目录` | 授予一个独立资料目录的只读访问 |
| `/files remove /绝对目录` | 撤销只读授权并重启工具 worker |
| `/context`、`/budget` | 查看上下文容量与分类预算 |
| `/stop`、`/about` | 停下活动、查看能力范围 |
| `/new`、`/resume`、`/quit` | 使用 Pi 自己的会话管理 |

默认只可读写 `playground/` 内的 UTF-8 `.md/.txt/.json` 小文件：单文件16 KiB、总量512 KiB、128文件、三层子目录。拒绝路径越界、软链接、脚本和覆盖冲突。授权资料目录只读，不能选配置目录或助手内部目录。模型不能修改记忆日志、策略、凭据和账本。

## 记忆与上下文

采用文件事件日志作为真相来源，Orama 3.1.18 加中文分词作为可重建的关键词检索索引；当前未启用 embedding。有效记忆包含压缩事实、逐字来源、时间和版本，区分用户事实、作品、公开知识和未完成问题。明确记住即时保存；普通用户消息累计约600字符后进行一次有界筛选，压缩前也补做一次。一次最多提取五条，来源必须能逐字对齐，不能将故事或模型猜测晋升为用户事实。

长文分片处理；未处理部分以原会话路径、来源ID和校验信息保留，重开后可继续，不保证一次压缩前提取全部细节。检索只注入少量完整事实，需要时 `memory_recall` 定位原文。旧原型 `memories.json` 不会自动导入。

遗忘是逻辑删除、同源排除和旧上下文屏障，**不是物理擦除磁盘上的原始会话**。对来源的更正会使旧版本失效；并发提取不能覆盖新更正或复活已遗忘来源。

默认工作容量65536，按需要可扩到131072，始终受实际模型窗口限制，并为输出保留空间。接近87.5%先标记，达到93%后在空闲、无队列且编辑器为空时调用 Pi 原生增量压缩；涉及原文细节且预算充足时可先扩容一次。保留约半个工作容量的近期原文。沿用原生历史摘要、split-turn前缀与原子提交，不修改 Pi 核心。真实 usage 优先；缺失时使用估算，不是精确 tokenizer。

用户可编辑 profile 的 `context-policy.json` 后重启。普通聊天最多1024输出tokens，探索768、审查256；压缩采用独立用途额度，避免被聊天短输出限制截断。

## 联网与沙盒

工具为 `read/write/list/web_search/fetch_content/get_search_content/memory_recall`。结构化工具 worker 复用现有 sandbox-runtime；内核限制写入活动目录与私有缓存，拒绝其他文件读写和本地网络。没有 Shell、GUI、克隆或执行工具；TUI 的 `!` 被拦截。初始化失败即拒绝工具，不回落到未沙盒执行。

搜索复用已安装的 pi-web-access 0.46.0 无界面 core，单查询、少量结果；抓取复用其 SSRF 校验和 curl 工具，仅支持公开 HTTPS 文字页、IPv4、无重定向、最多1 MiB。网页是资料，不能改变工具权限。默认不上传私人聊天作为搜索查询。

为适应本机 fake-IP DNS，可信宿主通过固定 Cloudflare DoH 地址查询A记录，再用既有私网检查验证并固定实际连接IP；未修改机器 DNS，也未放行私网。沙盒覆盖工具 worker，**不表示整个可信助手宿主进程都被 OS 沙盒隔离**。搜索凭据按次传递，不复制完整 auth。

## 费用与停止

后台沿用原研究累计账本 `outputs/inner-loop-integration/budget.json`，不清零。默认上限US$1、2048次、200万tokens；profile 之外的 `runtime-policy.json` 可由用户调整（`/budget` 展示位置）。请求前预留，结算后释放已知差额，错误或取消的未知消耗保留预留；超过限制就停止。探索、审查、记忆、压缩与搜索分类记账。金额是按目录价格峰值的2倍保守估算，不是账单。

**普通聊天单独记账，不扣后台US$1额度。** Pi 主会话页脚也不包含独立后台费用。默认共享 `~/.pi/agent/auth.json`；可用 `PI_CHAT_AUTH_PATH` 选择独立凭据。对话、相关记忆与工具片段会发送给所用模型提供方。探索使用已授权 DeepSeek 路由；普通聊天可选模型。

开始输入、普通回复、已上报失焦/鼠标活动、切会话或退出会取消旧探索，迟到结果不能发送。已完成作品保留。终端未上报焦点时无法可靠检测切窗。主动消息使用公开 `sendMessage(...,{triggerTurn:false})`，检查实际落盘，不伪造用户输入，不自动触发下一聊天轮。

## 安装与验证

```sh
node scripts/install-inner-assistant.mjs
python3 scripts/test.py
node tests/inner-assistant-terminal.mjs
node tests/inner-assistant-terminal.mjs --regular
node tests/inner-upgrade-terminal.mjs
node tests/inner-upgrade-terminal.mjs --regular
```

安装器只在缺失或版本不匹配时安装助手依赖。本机 `/opt/homebrew/bin/pi-chat` 已指向源码。上述测试不调用付费模型；覆盖真实 PTY、SDK、内核沙盒、中文记忆、遗忘、重开、读写和原生压缩。可控模型验证了连续5动作/3主动消息；它不能证明人类体验或长期自然度。

本次真实公网和真实模型的检查、费用、失败记录及限制见 [改造报告](../../experiments/inner-loop/upgrade-report.md)。未重跑冻结48场景，未测试游戏，未做真实128k长会话质量实验。历史阶段见 [早期报告](../../experiments/inner-loop/assistant-report.md)。

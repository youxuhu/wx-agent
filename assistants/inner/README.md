# Inner：聊天与自主活动 TUI demo

```sh
pi-chat
```

直接聊天即可。启动后即使你还没输入，它也能在自己的活动目录里选一个方向、读写草稿，判断有值得分享的内容时主动说话。不是固定探索三步，也不是最多只能主动说一条。没有实质进展时会休息；休息后不会因时间流逝自行再次调用模型。新的短用户消息完成普通回复后，可以开启下一段活动。

这是一个简单 demo：只有聊天与自主活动，没有 auto/shadow 等用户模式。`/stop` 停下当前活动，`/about` 查看活动目录，`/quit` 退出；Pi 原有 `/new`、`/resume` 仍用于管理助手自己的会话。更新代码后退出再启动。

```sh
pi-chat --new
pi-chat --regular
pi-chat --model deepseek/deepseek-flash
pi-chat --profile /绝对路径/另一个助手目录
```

旧的 `--auto` 参数仍可接受，但与默认启动相同。

## 它在什么地方活动

默认 profile 是 `~/.pi/assistants/inner/`：

- `playground/` 是模型唯一可以读写的活动目录。初始 `ideas.md` 放了杯子设计、门把手故事和文字游戏三个起点，可以自然选择或另起方向。
- `activity.json` 记录去重、进展摘要、未回应消息量及发送确认；模型不能通过文件工具修改它。
- `sessions/`、`settings.json` 和 `workspace/` 属于独立 Pi 运行时，不加载 coding agent 的项目、AGENTS、技能或扩展。

模型只有 `play_list`、`play_read`、`play_write` 三个工具。允许目录内 UTF-8 的 `.md/.txt/.json` 小文件：单文件 16 KiB，总量 512 KiB，最多 128 个文件、三层子目录；拒绝路径越界、软链接、控制字符和脚本。没有 Shell、网页或其他应用工具，TUI 的 `!` 也被拦截。文件是资料，不是新的系统指令。

原型的旧 `memories.json` 不会自动读取、删除或迁入；本版不再提供另一套长期记忆命令。已有会话可以继续。

## 怎么决定继续、说话和停下

`play-loop.mjs` 每次让模型选一个具体动作；宿主执行后，用第二次请求审查实际文件证据。新约束、有区别的比较、可检验的假设、实质创作发展可以算推进；仅换句话说、重复读取、写回原文或来回切换内容不算。模型审查仍可能误判，不能当作客观的创造力测量。

后续请求会拿到近期实际观察和进展摘要，避免读完就忘。没有固定步骤数量：下一步确实值得做、注意力允许、预算充足才继续。发言同样动态判断，另有重复检测和最多 600 字符的未回应主动文本额度；它可以连续说多条，也可能一条不说。额度不是“每几步必须说话”。候选应分享具体内容，少播报“我准备做什么”。

开始输入、已上报的失焦/鼠标活动、普通回复、切换会话或退出会中断探索，丢弃迟到发送，保留已写好的作品。完成后的短交互消息（最多 400 字符、900 UTF-8 字节）可重启活动；简单致谢或确认不会点火。未上报焦点的终端无法可靠检测切窗。

主动消息使用公开 `sendMessage(..., {triggerTurn:false})`，不伪装用户输入、不触发普通回复。发送前预留去重记录，发送后检查本次 JSONL 追加的 deliveryId；保存不确定时停止且不重发。纯主动消息的新会话通过公开会话记录落盘，再调用 `setSessionFile` 同步宿主状态，不修改 Pi 核心。

## 框架和费用

复用本机 Pi 1.4.0 的 SDK、模型接入、会话与 `InteractiveMode` TUI。独立 persona 负责普通聊天，不默认把每句话当编程任务；探索是可取消的异步工作链，自己的消息不会触发新的聊天轮次。

默认主聊天模型是 `deepseek/deepseek-flash`，每次最多 512 输出 tokens、不自动重试；普通聊天正常计费。主会话页脚不包含独立探索的费用。

探索继续使用原实验累计账本 `outputs/inner-loop-integration/budget.json`，请求前预留，错误/取消的未知消耗不归零；原上限 US$1、192 次、500,000 tokens，每次输入保守上界 2048、输出 384 tokens，超限停止。它是本轮 demo 的总实验额度，不是无限后台运行承诺。普通聊天不扣此研究账本。

默认共用 `~/.pi/agent/auth.json` 的现有凭据，不复制、不打印。需要独立凭据时设置 `PI_CHAT_AUTH_PATH=/绝对路径/auth.json`；Pi 的登录/退出会作用于所选文件。对话、活动文件片段和摘要会发送给所用模型提供方。支持 `--model` 选择普通聊天模型；探索仍固定为已授权的 DeepSeek 路由。

## 验证

```sh
python3 scripts/test.py
node tests/inner-assistant-terminal.mjs
node tests/inner-assistant-terminal.mjs --regular
```

这些不调用付费模型：覆盖文件边界、5 个连续动作/3 条主动消息、改写和重复停止、输入取消、真实 SDK 与 JSONL、两种真实 PTY 布局、零输入启动、普通聊天、停止和重开。可控模型用于验证流程，不代表自然聊天质量。

真实模型的新接入检查及失败记录见 [本轮报告](../../experiments/inner-loop/assistant-report.md)。不重跑已完成的 48 个冻结场景，不填造人工偏好评分。

本机 `/opt/homebrew/bin/pi-chat` 指向 `cli.mjs`。其他机器在 pi-config 执行 `node scripts/install-inner-assistant.mjs`，或直接运行 `node assistants/inner/cli.mjs`。不需要 GUI 或桌面构建。

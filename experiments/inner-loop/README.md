# Inner Loop：从合成研究到独立对话助手

当前用户入口是独立的 TUI 聊天 demo **Inner**。复用 Pi 框架，默认启动即可在自己的活动文件夹里探索、创作和主动说话；动态判断是否继续，没有固定三步或一条消息限制。只保留聊天与自主活动，详细使用、边界和费用见 [独立助手说明](../../assistants/inner/README.md)。

```sh
pi-chat
```

当前独立助手使用 `assistants/inner/play-loop.mjs` 与 `playground.mjs`。下面旧 coding-agent 扩展的多模式命令仍保留兼容，**不是本 demo 的操作入口**。原冻结研究没有修改或重新付费执行。

当前已加入文件记忆+Orama、64k/128k原生压缩调度、受限read/write、联网搜索与工具沙盒；游戏测试暂缓。实现与验证边界见[改造报告](upgrade-report.md)。

## 可复用的 TUI 扩展

`extensions/inner-loop/` 保留历史适配器及共用预算/注意力组件；旧 Pi TUI 扩展入口：

| 命令 | 当前语义 |
| --- | --- |
| `/inner-loop auto` | 自动探索并自行投递；明确选择此后短用户消息及普通回复片段 |
| `/inner-loop auto cards` | 只用显式添加的话题卡自动探索并投递 |
| `/inner-loop auto-shadow` | 事件驱动，但只保留候选供查看 |
| `/inner-loop shadow` + `add 内容` + `run` | 原手动预览流程 |
| `/inner-loop capture on/off` | 调整后续材料授权；off 后已有话题卡仍可按当前模式使用 |
| `/inner-loop prepare` / `show` / `say` | 可选的准备、预览和确认发送；自动模式不依赖它们 |
| `/inner-loop cancel` / `off` | 取消自动工作 / 关闭并清空话题授权 |

默认仍 off。`auto` 仅作用于当前会话；切会话、树导航、重载会清空授权。Pi 1.4.0 会缓存 `.mjs`，**更新源码后须重开进程，不能保证仅 `/reload` 会加载新版辅助模块**。独立 `pi-chat` 每次启动新进程，推荐从这里使用。

新材料来自明确 `add` 或开启之后真正的交互输入，不扫描旧对话、文件、剪贴板或代码项目。每条最多 400 字符、900 UTF-8 字节，保留最近三张、合计不超过 900 字节；对应普通回复取前 200 字符用于重复检查，必要时按预算进一步缩短。长消息可以正常聊天，但旧扩展会跳过自动捕获。不读取 thinking 或工具结果。

## 开口与停止

事件启动有限探索（最多三步）→ 引用/schema 校验 → 普通开口判断 → 同步最终归属/输入/忙碌/队列检查 → 一条消息或停止。自己的 custom 消息和其他扩展伪装的 user 来源不构成合法新材料；相同事件/来源依据不反复尝试。

`attention.mjs` 只观察终端焦点和鼠标转义序列，不记录按键内容，不轮询 OS。它在 fullscreen 消费序列前仍可收到标准输入事件；失焦/鼠标活动会取消旧结果，焦点回来不自动恢复。输入期间同样取消，并忽略 Enter 的键盘释放事件，避免刚启动的探索被同一次 Enter 的 release 误杀。没有焦点上报的终端仍无法保证检测切窗；不把它说成完整注意力测量。

消息通过公开 `sendMessage(...,{triggerTurn:false})` 写入，不伪造用户 prompt，不触发主模型。检查本次追加字节中的 deliveryId 才报告落盘成功；未确认就停止，不自动重发。全新空会话须等首轮普通 assistant 消息保存后才允许自动投递，不写伪造消息绕过 SDK 首次刷盘限制。

自然表达规则在 `conversation.mjs`：使用材料语言、具体且有依据的联系、温和推断，避免复述、泛泛建议和强行提问，不虚构记忆、私人思绪或情绪依赖。这是表达设计，不是已验证的心理状态或用户喜好。

## 证据、预算和验证

原 48 场景研究源码和数据保持冻结，不能重跑 `simulate.mjs --execute`。原研究没有证明锚定测量优于普通判断；原 15 条候选的人工标签仍为空，没有由模型代填。

```sh
python3 scripts/test.py
node experiments/inner-loop/reproduce.mjs
node tests/inner-assistant-terminal.mjs
node tests/inner-assistant-terminal.mjs --regular
```

上述默认不访问模型。另有真实 TUI 自动投递两调用和独立助手真实普通对话一次调用验证，详见 [本轮报告](assistant-report.md)。无需重跑已经成功的付费 smoke test。

自动探索继续共用私有 `outputs/inner-loop-integration/budget.json`，继承原研究已花预算；调用前预留，未知 usage 保留，原上限 192 次 / 500,000 tokens / US$1 不重置。累计为 **119 次、50,434 tokens、保守 US$0.04668**，其中最新动态活动接入新增 36 次（包含失败尝试）。普通用户对话按独立助手所选模型正常计费，主动分支另计，不包含在主会话页脚费用里。

历史过程见 [HANDOFF.md](HANDOFF.md)、[冻结研究报告](report.md) 和 [上一阶段 TUI 报告](tui-v2-report.md)；关于“auto 还只预览、必须 say”的旧描述已被当前实现替代。GUI/Web 和定时器均不在本轮范围。

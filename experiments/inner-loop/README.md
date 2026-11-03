# Inner Loop：有界主动聊天实验

当前完成：冻结的合成研究、离线复算、默认关闭的 TUI 手动/事件驱动 shadow，以及用户确认后的一条消息投递。
范围：只实现和测试 TUI，不处理 GUI/Web。无人值守主动插话仍未启用；人工偏好评价尚未完成，量表未证明优于普通判断。

## 使用 TUI shadow

扩展位于 `extensions/inner-loop/`，由 Pi 正常加载；现有 TUI 可 `/reload` 后使用。Web/RPC 不开放此入口，不需要打包桌面端。

```text
/inner-loop status
/inner-loop shadow
/inner-loop add 我正在设计一个庭院花园。
/inner-loop add 我想收集雨水来节约用水。
/inner-loop run
/inner-loop cancel
/inner-loop off
```

每张卡最多 400 字符、最多三张。`add` 的文字是本次显式授权材料，会发送给固定的 `deepseek/deepseek-flash`；不读取文件、聊天记录或剪贴板。`run` 每次手动启动，最多三步探索、一次普通判断；无材料、hold、非法输出或无进展即停，不重试。不支持 `active`，不会等待时间流逝后自行开口。

## TUI 事件驱动探索与自然表达

```text
/inner-loop auto
/inner-loop add 我想让庭院花园少依赖自来水。
# 新授权材料触发探索，但候选只留在内存，页脚提示可查看
/inner-loop show

# 可选：明确授权随后发送的短消息及普通回复片段
/inner-loop capture on
# 只在用户发起的普通对话真正 settled 后探索；自身输出不点火
/inner-loop capture off
```

`capture on` 使用开启之后的用户短消息（每条最多 400 字符、900 UTF-8 字节）和对应普通回复的前 200 字符来避免重复；不读取既往聊天、thinking 或工具结果。最多保留三张卡，过长消息跳过；请求若超过原始预算上界则停止。人工 `add` 的卡片合计最多 900 UTF-8 字节。材料不变时不靠重复 settled 事件再问模型。新材料到达时先取消旧请求，只保留最新一次事件，等旧请求结束后再处理，不并发抢占预算账本。

新表达规则在 `extensions/inner-loop/conversation.mjs`：跟随材料的语言、提出具体且有依据的联系，优先温和观察，避免复述、泛泛建议和强行提问；不虚构共同记忆、孤独感或需要用户回应的情绪。它是表达设计，不能当作用户已认可或心理需求的证据。冻结研究提示词未改动。

## 确认发送一条想法

```text
/inner-loop prepare
# 候选准备完成；可先用 show 查看
/inner-loop say
```

`prepare`（别名 `once`）仅准备候选，不直接发言；`say` 是用户当前的明确发送操作，最多发送一条，之后关闭并清空话题授权。需要已有保存记录的会话、空闲 TUI、空编辑器且没有排队消息。候选经过取消、普通新输入、树导航、切会话或重载后失效；重复 say 不会重发。不触发主模型。

这样处理的原因是已核查 Pi 1.4.0：公开扩展接口没有可靠的终端窗口焦点/连接信号，fullscreen 的焦点与部分滚动事件会在扩展之前被 TUI 消费，不能用空编辑器冒充可靠注意力。自动工作保持 shadow，最终说话以当前 say 命令为准。发送后仅检查本次操作新追加的文件字节，确认 deliveryId 已落盘才报告保存成功；失败或不确定时停止，不自动重试。

`shadow` 仅对当前会话生效。新输入、取消、会话切换、树导航、重载会使旧结果失效；切会话或重载恢复 off。仅在 TUI 空闲、编辑器为空、无排队输入时允许运行和发布。RPC 的注意力、writer lease 和连接语义未接入，直接拒绝。

手动 `run` 或 `show` 通过 `sendMessage(..., {triggerTurn:false})` 保存明确标记的 shadow 预览，**不是一次主动投递成功**。预览会进入当前会话记录及后续模型上下文；自动 shadow 只保留内存候选及页脚状态。`say` 保存独立的 `inner-loop-approved` 消息，来源为 `user-approved-once`，不冒充用户输入。卡片和运行状态仅存内存；`clear`/`off` 清空它们，但不删除已存的消息。

持久化限制：Pi 1.4.0 的全新空会话直到第一条 assistant 消息才首次刷盘。空会话中只有 shadow 预览时，不能保证崩溃后恢复；集成测试通过一条合成 assistant 记录触发首次刷盘，再重开验证预览。扩展不伪造真实 assistant 消息来绕过此限制。

## 验证与预算

```sh
python3 scripts/test.py
node experiments/inner-loop/reproduce.mjs
```

默认测试不访问模型。`tests/inner-loop-integration.mjs` 验证 SDK 命令、消息组件、持久化和会话替换；`tests/inner-loop-tui.mjs` 验证事件/授权/自激禁止/输入取消/重载。额外用 `node tests/inner-loop-terminal.mjs` 驱动真实交互式 Pi TUI（PTY，默认 fullscreen，`--regular` 可测普通模式），验证准备、确认、落盘、重放拒绝和键入取消；使用本机已有的 node-pty，不接触 GUI。

真实 DeepSeek 的 TUI 两调用验证已完成。再次运行带 `--execute` 的终端测试会付费，不属于日常回归，不能为了复核已成功样例而重复运行。

固定研究的 `simulate.mjs --execute` **不要重跑**。冻结源码与证据保持原样。新接入账本在私有 `outputs/inner-loop-integration/budget.json`，继承原研究的 74 次调用及保守预留；发请求前落盘预留，用排他锁阻止并发，错误/未知 usage 不释放预留。锁因崩溃残留时停机人工核查，不自动解除。全局上限仍为 192 次、500,000 tokens、US$1，无自动重试。

2026-11-03 累计：80 次、33,826 tokens、保守估计 US$0.0303072，剩余最多 112 次。包含本轮范围收敛前已发生的两次接入请求，未因撤回代码而清除费用。这里的金额是模型目录费率估计，不是账单。

文件地图和历史边界见 [HANDOFF.md](HANDOFF.md)，研究结果与限制见 [report.md](report.md)。15 条候选的 [人工评价包](evidence/review.md) 尚未由用户打分，禁止模型代填。

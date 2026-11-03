# Inner Loop：有界主动聊天实验

当前完成：冻结的合成研究、离线复算、默认关闭的 TUI 手动 shadow 接入。
尚未完成：真实主动插话、Web 接入、人工偏好评价。量表不是心理状态，未证明优于普通判断。

## 使用 TUI shadow

扩展位于 `extensions/inner-loop/`，由 Pi 正常加载；现有 TUI 可 `/reload` 后使用。无需重建桌面端。Web/RPC 不开放此入口。

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

`shadow` 仅对当前会话生效。新输入、取消、会话切换、树导航、重载会使旧结果失效；切会话或重载恢复 off。仅在 TUI 空闲、编辑器为空、无排队输入时允许运行和发布。RPC 的注意力、writer lease 和连接语义未接入，直接拒绝。

结果通过 `sendMessage(..., {triggerTurn:false})` 保存为明确标记的 shadow 预览，**不是一次主动投递成功**。预览会进入当前会话持久化记录及后续模型上下文；不自动触发主模型，也不重新启动探索。卡片和运行状态仅存内存；`clear`/`off` 清空它们，但不删除已存的会话预览。真实主动投递仍不存在。

## 验证与预算

```sh
python3 scripts/test.py
node experiments/inner-loop/reproduce.mjs
```

默认测试不访问模型。`tests/inner-loop-integration.mjs` 用真实 SDK 命令派发、SessionManager、TUI 消息组件及 AgentSessionRuntime 验证，离线推理用受控替身；真实 DeepSeek 接入已另做一次两调用验证。再次运行带 `--execute` 的集成脚本会付费，不属于日常回归。

固定研究的 `simulate.mjs --execute` **不要重跑**。冻结源码与证据保持原样。新接入账本在私有 `outputs/inner-loop-integration/budget.json`，继承原研究的 74 次调用及保守预留；发请求前落盘预留，用排他锁阻止并发，错误/未知 usage 不释放预留。锁因崩溃残留时停机人工核查，不自动解除。全局上限仍为 192 次、500,000 tokens、US$1，无自动重试。

2026-11-03 新验证后累计：76 次、32,537 tokens、保守估计 US$0.0291036，剩余最多 116 次。这里的金额是模型目录费率估计，不是账单。

文件地图和历史边界见 [HANDOFF.md](HANDOFF.md)，研究结果与限制见 [report.md](report.md)。15 条候选的 [人工评价包](evidence/review.md) 尚未由用户打分，禁止模型代填。

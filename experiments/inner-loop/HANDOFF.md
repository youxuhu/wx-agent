# Codex 交接：Inner Loop 主动聊天探索原型

## 最新范围与 TUI 第二阶段

用户明确要求只处理 TUI，不处理 GUI；本轮 Web 改动和构建产物已撤回。当前新增事件驱动 shadow、显式后续材料授权、自然表达规则及 prepare/show/say 的用户确认一次发送；TUI 注意力信号不足时不启用无人确认 active。真实交互式终端 regular/fullscreen 与真实模型两调用验证已完成。累计账本 80 次、33,826 tokens、保守 US$0.0303072；不清除撤回代码前的请求费用。详见 [tui-v2-report.md](tui-v2-report.md) 及更新后的 README。下面是先前阶段记录，以此段为准。

## 2026-11-03 Codex 接手后状态（优先于下方原始快照）

- 已新增 `extensions/inner-loop/`：默认 off，TUI `/inner-loop shadow / add / run / cancel / clear / off / status`，只用显式卡片，手动 shadow，无 active 或 Web 接入。
- 真实 SDK 命令、TUI 组件渲染、JSONL 重开持久化已验证；离线可控请求验证取消和 AgentSessionRuntime 真正换会话后的迟到结果阻止。
- 新增一次两调用 DeepSeek 集成测试成功；原 48 场景未重跑。累计 76 次、32,537 tokens、保守 US$0.0291036；独立账本在 `outputs/inner-loop-integration/budget.json`，仍继承原预算。
- 已补 README/report；`scripts/test.py` 接入原 34 项测试和新 SDK/预算检查。人工评价仍空缺，不能由模型代填。
- 最终全量离线回归通过；固定版本 LSP 对 13 个研究/接入模块零诊断；冻结 hash 与公开证据复算一致。提交推送状态以 Git 历史为准。
- 下方“没有入口、文档未写”等描述为接手前历史快照。当前使用及验证边界见 [README.md](README.md) 与 [report.md](report.md)。定时器不处理，机器配置和 token-confidence 成果仍排除。

---

以下保留原始交接快照：

> 更新：2026-11-03，Asia/Shanghai。
> Owner：**external-codex**。用户准备把本文件交给 Codex 接手；原会话不再启动新的实现工作。
> 开发仓库：`/Users/revy/.pi/agent`，分支 `main`，当前 HEAD `8b2d28a`。
> **用户最新指令：不用处理定时器。不要创建、修复或排查定时任务。** 没有创建成功的续跑定时器，也没有已启动的实现子代理。

## 1. 用户要什么，已经授权到哪里

用户希望聊天 AI 不依靠周期定时器发言，而是在一个授权范围内自己探索，形成候选想法，再借用心理测量式的构念与配对判断，决定开口还是保持安静。

用户已确认 P0–P2 计划，随后又明确允许在收尾后继续做实际测试与落地。可以继续做公开接口接入和隔离会话端到端测试，不必重新询问是否可以写原型。

但必须保留边界：

- 真实入口默认 **off**，不能静默启用真实聊天主动插话。
- 默认只能使用合成材料或用户显式提供/选择的材料；不能自行扫描私人聊天历史、磁盘、联系人、剪贴板或浏览记录。
- 不自动后台联网巡游、不执行探索工具命令、不写真实项目内容、不往其他应用发通知。
- 不重建桌面端；用户没有要求本轮打包，打包会关闭在跑的 app。
- 人工偏好必须由用户评价，不能让第二个模型代填“用户喜欢”。
- 不把模型自评分称为真实心理需求，不设置孤独/焦虑等需要用户回应的情绪驱动；不把 token 概率当作开口欲望。

核心结构：事件/工作队列启动有限探索 → 产生候选 → 比较现在说与保持安静 → 最终硬门复核 → 一条候选或停止。

没有新材料、没有进展或预算用尽时应停止，不反复询问模型直到它同意发言。自己的输出不能重新点火。时间可以用于 timeout/预算记账，但时间流逝本身不能增加说话动机。

## 2. 当前完成程度：不是已上线的功能

**已完成：独立实验原型 + 48 个合成场景的模型实验 + 公开合成证据与复算程序。**

**尚未完成：生产扩展/聊天 UI 接入、真实 SDK 会话端到端验证、人工体验评价、完整回归入口接入、当前代码提交推送。**

现在没有 `/inner-loop` 等可供用户调用的已安装命令，没有常驻探索服务，没有真实聊天主动输出。

## 3. P0 接口与文献核查

### 已确认的公开接口

Pi/SDK 版本为 1.4.0，Node 22.23.3。本机核心：

`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`

已读相关 SDK/扩展文档与声明，确认：

- `ModelRuntime.create({allowModelNetwork:false})`、`getModel()`、`streamSimple()` 可做与主会话分开的推理。
- `agent_end` 只是低层运行结束，之后可能还有自动恢复或队列；`agent_settled` 才是自动工作停止边界。
- `pi.sendMessage({customType,content,display,details},{triggerTurn:false})` 是公开自定义消息入口，不必修改核心。
- `sendUserMessage()` 总会触发一轮，不应伪装用户输入来投递主动候选。
- `before_agent_start` 可区分 user/custom 来源；必须做来源标记，避免自激循环。
- `getEditorText()` 等 TUI 能力不能直接等同浏览器 composer 的输入状态。
- piwebui 已有 active-workspace + writer lease：`extensions/piwebui/server/main.ts` 的 `resolve()`、`claim_writer/release_writer`，不能绕过。
- piwebui 自定义消息渲染、浏览器输入中状态、主动消息的持久化和来源归属仍需真正实现/验证，不能声称已有完整接入。

P0 证明了独立原型有公开 primitives 可用，不是对未来 active 功能的端到端通过证明。

### 文献

直接相关：**Proactive Conversational Agents with Inner Thoughts**，CHI 2025，DOI `10.1145/3706598.3713760`，arXiv `2501.00383`。

已通过检索核对题名、作者与方法概述。正文抓取被 fake-IP/SSRF 检查阻断，未完成全文复核，没有绕过限制。不要引用未经复核的提升数字，不把本实验说成论文复现；不需要继续折腾网络安全配置来推进工程原型。

## 4. 实现文件地图

全部位于 `/Users/revy/.pi/agent`：

| 文件 | 当前作用 |
|---|---|
| `experiments/inner-loop/protocol.json` | 预登记范围、费用/调用上限、场景与策略；当前版本1.2 |
| `graph.mjs` | 授权只读话题图、引用片段校验、按来源依据去重、合法探索前沿 |
| `measure.mjs` | 探索/候选/决策schema，R/N/O/G/I/D锚点结构、自相矛盾诊断 |
| `policy.mjs` | session/workspace/epoch/授权快照、输入/忙碌/连接/租约、引用与重复硬门 |
| `state.mjs` | Episode、最多3步探索/1次评估/1条shadow候选、取消、旧结果失效、事件去重、自激禁止 |
| `fixtures.mjs` | 24基础场景×clean/injected，6类注入，固定乱序 |
| `prompts.mjs` | 共享候选生成、普通判断、锚定测量配对判断；当前合成材料/输出为英文 |
| `budget.mjs` | 发请求前预留成本、转义后wire字节上界、未知usage保留、超限锁死 |
| `simulate.mjs` | 显式`--execute`才调用模型；不接真实聊天；完成后不自动重跑 |
| `analyze.mjs` | 已冻结的描述性分析，人工满意度字段保持null |
| `reproduce.mjs` | 纯离线复算与证据/匿名人工评价包导出；不导入SDK/凭据 |
| `evidence/run.json` | 已公开的合成结构化数据，去除了provider response ID |
| `evidence/summary.json` | 可复算结果 |
| `evidence/review.md` | 15个候选的人工评价包，未提供模型策略名称或自评分 |
| `evidence/ratings-template.json` | 待人工填写的空标签模板 |
| `evidence/review-map.json` | 人评ID与场景的映射 |
| `tests/inner-loop.mjs` | 34项离线单测 |
| `continue.workflow.js` | 之前准备的续跑工作流文本，**未启用，用户已说不处理定时器** |
| `HANDOFF.md` | 本交接文件 |

**不存在的文件不要误报已完成：** `experiments/inner-loop/README.md`、`experiments/inner-loop/report.md` 仍未写。

根目录 `AGENTS.md` 仅新增了一条本轮简短变更/问题记忆，不是第二份交接。

## 5. P1 状态机与验证结果

运行原型只支持 `off / shadow`；传 `active` 会抛错。shadow 返回 `wouldSpeak` 和 `delivered:false`，**没有真实 sender**。

当前实现覆盖：

- 授权的 notes/IDs，引用必须为已有精确片段；可读的 untrusted 指令不具有引用权威。
- 探索最多3步，每步需要访问新节点；hold、无合法前沿或无进展即停。
- 最多一次开口评估、一条shadow候选。
- session/workspace/epoch/version/授权和材料快照失配，拒绝迟到结果。
- 输入中、忙碌、未知注意力、安静模式、断线、非active workspace、缺writer lease时不放行。
- 用户取消后不接收迟到结果；重启不能恢复旧episode待发送结果。
- 相同外部事件不重复启动；agent/custom/timer不是合法外部点火来源。
- 同一来源依据换个措辞不当作新的话题。
- schema/预算/来源未知时fail closed。

最后保存的单测日志：`outputs/inner-loop-tests.log`，**34/34 PASS**。

LSP 检查曾覆盖 `state.mjs / simulate.mjs / measure.mjs`，修正一个JS属性hint后 `simulate.mjs` 为0诊断；随后做过格式/字节预算修复，**最终版本尚未重跑LSP**。`node --check` 与34项单测在最终付费实验前通过。

**没有跑本轮完整 `scripts/test.py`，也尚未把 `inner-loop.mjs` 加进该入口。**不要把本轮局部通过说成全仓回归通过。

## 6. P2 真实模型实验结果

### 冻结与范围

- 48实例：24基础场景×clean/injected，随机种子9127。
- 6类：新联系、重复、无支持断言、低新增价值、忙碌、无材料；每类4个基础场景。
- 6种注入：错误来源、陈旧快照、恶意笔记、重复伪装新颖、撤销授权、切会话。
- 三种策略共享候选，但counterfactual状态相互隔离，防止先运行的策略消耗后者配额。
- 冻结hash：`0f59dfc7634e588ddc89589f4ace745b6a3c0f7ff36fd278603f8ad0e79af62d`。
- 没有真实投递，模拟提交硬门违规为0。**这不是线上安全证明。**

### 结果

| 策略 | 48场景最终wouldSpeak | 结构问题 |
|---|---:|---|
| 简单“有候选就说”规则＋共同安全硬门 | 8 | 不需模型评估 |
| 普通开口判断 | 4 | 9次模型评估均通过schema |
| 锚定测量＋说/不说配对 | 4 | 9次中4次决策schema不合格，按规则保持安静 |

普通与锚定均压住重复场景；不应由此宣布锚定层有效。

- 重测：5次，4次结构有效；有效样本中选择一致。
- 反转“说/不说”选项：5次均结构有效，只有3次保持选择，**2/5改判**。
- 9次原始配对决策中有1次不同，且有1次锚定自评分与开口决定相冲突。
- 额外探索8次，5次通过步骤/引用schema并产生候选，3次invalid-step。
- 15个第一阶段候选进入人工评价包，**尚无人类评分**。

### 注入覆盖不能夸大

每种故障分配4次，但一些场景本来就没有候选或已被前置硬门压住，因此实际被执行的注入数分别为：

| 类型 | 分配 | 实际触达 |
|---|---:|---:|
| wrong-source | 4 | 2 |
| stale | 4 | 2 |
| malicious-note | 4 | 4 |
| duplicate | 4 | 1 |
| revoke | 4 | 1 |
| switch-session | 4 | 1 |

其余边界有单测覆盖，但不能声称所有4次都经过了真实模型的对应故障路径。

额外探索是独立的counterfactual消融分支，并非生产式贯穿撤销状态的真实会话闭环；未来真实接入必须让探索与提交共享同一取消/授权状态。额外候选没有再次做表达评估，不能用它算体验提升或因果增益。

### 当前判断

有界探索、候选产生、主动选择沉默与硬门机制已经可演示。但锚定测量在小样本中出现schema脆弱与明显次序效应，**没有证明优于普通判断**。

落地建议优先采用普通判断，测量层保留实验开关；不要为了术语复杂而默认加它。候选多数只是温和综合已有事实，不能宣称出现了稳定的创造性或心理动机。

## 7. 费用、失败与不得重置的总预算

路由固定为 `deepseek/deepseek-flash`，`api.deepseek.com`，thinking disabled，temperature 0.2，无自动重试。

总批准上限：**192次调用尝试、50万tokens、US$1**；每次输入≤2048（UTF-8字节保守上界）、输出≤384、timeout60秒。开发模型为用户当前的 `openai/gpt-6.1-sol`，不要静默切换或修改默认模型。

目前：

- 预算计数 **74次**，含5次前置尝试，不是48场景×固定调用数。
- 已知usage **27,887 tokens**：input23,435、output4,452，其中缓存输入5,885。
- 已知usage按catalog估计约 **US$0.01064271**，不是账单，也不包含未知usage的真实费用。
- 未知usage保留预留后，保守记账 **31,922 tokens / US$0.0285492**。
- 余量最多118次尝试；成本与tokens必须继续累计，不得另开ledger就把已花部分清零。

本机私有运行产物（gitignored）：`outputs/inner-loop/`。

失败前置过程已保留：`attempt-1.json`、`attempt-2.json`、`run.halted.json`、`run.halted-2.json`、`preflight.json`。最终 `run.json` 包含已累计的费用和前置尝试信息。

两个踩坑已修复：

1. JSON response_format要求提示明确包含JSON字样；普通判断初版漏了。修正仅格式，不改变模型/任务/决策策略。原始第一次错误消息未持久化，因此最初根因是格式检查与后续成功的诊断，不是保留了供应商逐字错误证明。
2. 消息内容嵌套JSON后，wire编码会额外转义。原先只按逻辑文本加固定framing，锚定请求在onPayload被本地保护拒绝；已用**只预览payload、抛错阻止HTTP**的方法确认真实wire大小，再改成两种上界取max。不能为了跑通去删字节保护。

同时修复了错误响应0 usage被提前结算释放预留的问题：先判断错误，再settle；最初已释放的那一份预留已手动恢复并累计。没有用重试洗掉预算或删掉失败证据。

**不要再次付费运行原 `simulate.mjs --execute` 来“验证”结果。** 已完成，重新执行应不发请求；改冻结代码后它会拒绝不匹配。后续集成测试应开独立输出目录/ledger，明确继承本轮已花预算，不覆盖研究证据。

## 8. Codex 接手后的建议顺序

### A. 先收尾，不重做实验

1. 阅读本文件、根目录AGENTS、git状态和最近提交；注意这是有未提交成果的工作树。
2. 写 `experiments/inner-loop/README.md / report.md`，严格区分模型自评、模拟硬门与真实用户体验。
3. 为最终代码再跑相关LSP；把 `tests/inner-loop.mjs` 加入 `scripts/test.py` 后跑全量离线回归。
4. 检查公开evidence只有合成内容，没有凭据/原始reasoning/私人prompt。
5. 提交并推送本轮明确文件，记录提交hash。

### B. 继续实际接入与端到端验证（用户已授权做）

1. 在 `extensions/inner-loop/` 等合理位置实现**默认off**的最小适配器，可显式提供话题卡，显式启动/停止探索与查看shadow候选。
2. 使用公开ModelRuntime/生命周期/自定义消息接口；不改核心hash补丁，不用伪造用户prompt来输出。
3. 原型当前的 `active` 未实现，不要直接把shadow布尔值当真正发送成功。真实投递需要单独的事务/取消/归属门，并验证持久化与UI渲染。
4. 用隔离AgentSession、无工具、合成材料实际跑事件/取消/切会话路径，不能只有fake模型就宣称真实集成通过。
5. TUI可先落最小入口；若做web，需要明确composer输入状态、writer lease、自定义消息渲染和重连语义。缺失信号保持安静，不假设用户空闲。
6. 用户没选择真实材料范围前，保持off。shadow/active真实聊天使用需要显式开关，不自动读取当前全量会话。
7. 人工评价包可让用户分批评价，不把AI代评当主指标。锚定schema和选项顺序问题可以另开版本修复，但不能修改冻结数据以制造好结果。

### C. 已取消的工作

**定时器不再是待办。** 用户最新说“不用处理定时器的问题”。

此前目标项目打开被运行时阻止，Herdr也未安装；改登记当前项目获用户同意后，原定时间已过，schedule.create未成功。最后schedule.show明确返回not found。不要安装Herdr、改cron、重试调度或自动顺延日期。`continue.workflow.js`只是未启用文本，可忽略。

## 9. 可直接执行的离线检查

所有shell命令先进入pi-config；文件工具使用绝对路径：

```sh
cd /Users/revy/.pi/agent
git status --short
git log -3 --oneline
node --test tests/inner-loop.mjs
node experiments/inner-loop/reproduce.mjs
# 接入test.py后再跑：
python3 scripts/test.py
```

`reproduce.mjs`不访问模型，会从公开evidence重新分析并与summary比对。`simulate.mjs`是付费程序，不能混入默认测试入口。

`continue.workflow.js`是pi-subagents工作流函数体，不是普通Node模块，不要对它按普通脚本执行。

## 10. Git与维护边界：很重要

截至交接：**本轮未提交、未推送**。HEAD仍是 `8b2d28a`。

已存在的机器本地改动：

- `M sandbox.json`
- `M settings.json`
- `?? notify.json`

不要带入提交。不要 `git add -A` 或泛化 `git add experiments/`。

本轮可明确暂存：`experiments/inner-loop/`、`tests/inner-loop.mjs`、新根目录 `AGENTS.md`，以及之后确实修改的 `scripts/test.py` 和实现适配器文件。原始运行logs继续ignored。

只允许推送 `/Users/revy/.pi/agent`；不要操作其他仓库remote或推送minepi。Git代理若未开，已知临时绕过是 `git -c 'http.https://github.com.proxy=' push`，不是笼统 `-c http.proxy=`。

SDK测试通过 `tests/helpers.mjs` 找核心。LSP使用仓库自有固定版本安装树 `lsp/node_modules`，不要改成PATH或旧的 `~/.pi-lens/tools`，不要新增手工setup流程。

## 11. 同工作树还有上一轮未提交成果：不要误覆盖或混入

另有 `experiments/token-confidence/`、`tests/token-confidence.mjs`、`tests/token-confidence-experiment.mjs`，是上一轮研究，**不属于本轮提交范围**，不要删除。

它已完成4次能力探测 + 48组文本JSON行动模拟/108步：原生工具参数无logprobs，只有普通content可观测。共112调用、20,755tokens；出现2个错误，但某错误行动几何平均token概率仍99.94%。原始surprisal本批排序好，预设融合模型无足够增益，只有2个错误簇，不能上线或显示路径正确率。

相关结论已在 `experiments/token-confidence/report.md`，不需要重跑付费实验。该轮测试尚未接入 `scripts/test.py`，README/全量回归/提交收尾未全部做完。除非明确扩展本轮范围，否则保持原样。

## 12. 接手时最需要记住的三点

1. **原型和合成实验是真的做完了，但没有安装成真实聊天功能。**
2. **先实现安全、默认关闭的实际接入；量表不是已验证的心理状态，不是默认必需层。**
3. **所有实验、人评缺口和费用都保留原样；不处理定时器，不重跑旧实验，不混入机器配置和上一轮代码。**

# Pi 下一阶段计划：轻量功能与插件维护

日期：2026-11-02。状态：已实施并安装；当前 Pi 进程需 `/reload`。未提交或推送。实测、命令和边界见 [实施报告](/home/revy/minepi/pi-agent-upgrade/docs/LIGHTWEIGHT.md)。下文保留选型与维护依据，执行结果见第 9 节。

## 1. 决策

**继续使用上游实现通用能力；本地只维护少量交互、策略和适配代码。优先停用 pi-lens 的整套自动分析，以项目原生验证为主，必要时用按需 LSP 补充。**

用户约束继续有效：英文简洁信息栏；watchdog 跟随当前模型、thinking=low；仅百万窗口模型在约 50% 压缩；常驻提示词精简。不能将本计划全文注入模型。

本地 undo/redo、footer、watchdog 桥、验证记录与健康检查已安装。本次已补提示词去重、按需 LSP、输出检索和交接，并保留运行时回归测试；原 PLAN.md 中更广泛的 deferred 改造未全部完成。

## 2. 插件现状与维护选择

选型阶段核对了 npm registry 的 latest、上游仓库及发布说明；下表为选型时快照，实际运行版本以 maintenance-lock.json 为准。不能用仓库主分支版本号代表 npm 已发布版本，也不能将 Unreleased 内容当作本机已有能力。

| 组件 | 本机 | npm latest | 建议 | 本地维护边界 |
|---|---|---|---|---|
| Pi 核心 | 1.4.0 | 1.4.0 | 跟随上游，经过兼容检查再升级 | 不 fork agent loop、会话树、provider/auth 层 |
| pi-web-access | 0.46.0 | 0.46.0 | 保留，锁定已验证版本，定期评估新版 | 维护搜索配置和结果预览策略，不重写抓取/搜索后端 |
| pi-subagents | 0.84.0 | 0.84.0 | 保留并继续锁版；优先解决状态桥接口耦合 | 维护薄桥；不 fork 工作流、调度、watchdog 引擎 |
| pi-lens | 4.4.7 | 4.4.8 | **退出默认配置；保留可回滚副本** | 不接手整个扫描/LSP/规则引擎 |
| rpiv-todo | 2.15.0 | 2.15.0 | 保留，跟随上游兼容发布 | 配置简短 guidance 与本地任务语义 |
| rpiv-ask-user-question | 2.15.0 | 2.15.0 | 保留，与 rpiv 系列一起验证升级 | 不重写问卷 UI、交互和校验 |
| pi-btw | 0.63.3 | 0.63.3 | 保留按需功能，跟随上游修复 | 不接手终端分屏、输入恢复等复杂基础设施 |

rpiv 系列及相关依赖采用同一验证批次；不能只更新其中一个 UI/配置包就假定兼容。上游都未归档，但活跃不代表没有回归；不以星数或提交次数决定升级。

依据：[Pi 核心](https://github.com/earendil-works/pi)、[web-access](https://github.com/nicobailon/pi-web-access)、[subagents](https://github.com/nicobailon/pi-subagents)、[rpiv](https://github.com/juicesharp/rpiv-mono)、[BTW 发布记录](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-btw/CHANGELOG.md)。精确 npm 版本和 integrity 保存在 `audit/plugin-npm-latest.json`，仓库状态保存在 `audit/plugin-upstream-repositories.json`。

### 自行维护的部分

- checkpoint 的用户轮次 undo/redo 与冲突保护。
- llm-speed/footer 的布局、状态展示和统计缓存。
- runtime-support 的健康检查、验证证据和少量事件适配。
- computer-use 的 WSL/Windows 适配和用户操作约定。
- policy、快照保护及配置同步/推送策略。
- read_pdf/read_xlsx 的小范围读取适配；尽可能调用成熟解析工具，不自行实现解析器。

通用能力优先给上游反馈接口需求；本地特定的英文布局、50% 压缩范围、undo 语义由我们维护即可。本轮不会向任何仓库发 issue/PR。

## 3. pi-lens：为何出现噪声，如何替代

### 已确认的机制与尚未确认的原因

本机没有发现 `~/.pi-lens/config.json` 的显式降噪配置。安装版的默认能力包括 LSP、编辑时检查、测试、格式化、autofix，以及向后续模型请求注入诊断；其中部分规则会要求处理已有问题。这些是可能让 agent 被无关问题带走的来源。

尚未逐条复现用户遇到的报错，因此不能宣称全部是误报。应区分：真正的本次回归、原本已有问题、编辑过程中的临时语法错误、工程根目录/依赖配置错误，以及复杂度/重复代码等建议。严重性标签本身不能替代复现。

4.4.8 已加入按 runner 禁用能力，并改善部分规则及导航输出，但升级不能自动保证消除噪声。用户偏好轻量，因此不以调试整个 lens 规则系统作为默认路线。[4.4.8 发布记录](https://github.com/apmantza/pi-lens/blob/master/CHANGELOG.md)

### 替代品比较

| 方案 | 有什么 | 默认开销与限制 | 选择 |
|---|---|---|---|
| `rg` + read + 项目 test/lint/typecheck | 搜索、阅读、项目权威验证 | 不增加插件；文本搜索不具备真正的语义引用查询 | **默认基础方案** |
| `@narumitw/pi-lsp` 0.49.11 | `lsp_diagnostics`、`lsp_fix` 两个工具 | 调用时启服务、结束后关闭；只做诊断/源码 action，不提供定义/引用跳转 | **需要 LSP 时优先试用** |
| `pi-lsp-adapter` 0.1.3 | 只读诊断、hover、定义、引用、symbols、结果分页 | 七个工具及服务管理；可配置 warmup，需关掉不需要的预热 | 确有跨文件语义导航需求时备选 |
| `pi-lsp-extension` 1.4.0 | LSP、AST 搜索、overview、rewrite 等 | 多个工具、tree-sitter 资源，已有服务时自动回传编辑错误 | 不作为本轮轻量首选 |
| `@arcdev-llc/pi-lsp` | 一个 lsp 动作工具，支持禁用自动诊断 hook | 仓库最后 push 为 2026-04-10；本轮 npm latest 查询失败，尚未确认发布/兼容状态 | 保留候选，不直接安装到主配置 |

来源：[双工具按需 LSP](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-lsp)、[只读 LSP adapter](https://github.com/nikmmd/pi-lsp-adapter)、[完整 LSP extension](https://github.com/samfoy/pi-lsp-extension)、[单入口 LSP](https://github.com/arcdev-llc/pi-lsp)。工具少不等于实际更快；服务冷启动、语言和项目规模需要实际测量。

**推荐目标：默认停用 lens，保留 rg/项目命令；需要诊断时启用双工具 pi-lsp，不强制每次编辑后调用。** 若平时不需要中间诊断，可以连替代插件也暂不装。

### 迁移步骤

1. 保存当前 packages、lens 配置、工具/Skill 清单及可回滚的版本来源。
2. 在隔离配置中移除 pi-lens 的启用项，暂时不删安装文件；同时检查角色、preset、Skill 是否仍引用 `lens_diagnostics`、`read_symbol` 等旧工具名。
3. 先验证纯 `rg + read + 项目验证命令` 是否满足日常任务；不自动添加语义搜索数据库或额外常驻服务。
4. 若确需中间诊断，测试并固定 `npm:@narumitw/pi-lsp@0.49.11`。只配置实际使用语言的现成 server，不批量安装全部语言服务。自定义 server map 会整体替换默认目录，必须核对完整配置。
5. 诊断调用显式提供本次相关 paths、选定 server 和有限的文件数量；不使用默认全 workspace 扫描。`lsp_fix` 保持预览模式，只有当前任务需要才写文件。
6. 若需要定义/引用而不是诊断，另测 pi-lsp-adapter；它与双工具 pi-lsp 是不同取舍，不为凑功能同时安装两套 LSP。
7. 主配置中只保留一套 LSP。移除 lens 的四个配套 Skill 和旧工具引导，避免模型继续找不存在的工具；回滚时成组恢复。
8. 同时检查 watchdog 的 TypeScript/JavaScript LSP pre-pass，防止停用 lens 后仍有另一条自动诊断路径重复报告。没有实际需求就按插件正式配置关闭该预检查，保留模型监督。

本机 PATH 有 rg，但未找到 typescript-language-server、pyright-langserver、jdtls；这不排除 lens 在自己的工具目录管理了服务。迁移时先查现有服务与版本，不承诺零依赖可直接用。`/usr/bin/sg` 是用户组工具，不得把它当作 ast-grep；如需结构化检索，只明确调用核对过的 ast-grep 二进制。

### 若必须暂时保留 lens

可使用其原生全局配置降噪，而不是隐藏所有 error：关闭 `contextInjection.enabled`、`tests.enabled`、`format.enabled`、`autofix.enabled`，并设置 `contextInjection.requirePreExistingFixes=false`；按需使用导航。真正阻断执行的错误仍应通过项目命令暴露。

这些配置多数是全局字段，不能随意放到项目 `.pi-lens.json`。项目级 mutation 配置还可能覆盖全局默认；需要严格关闭格式化/autofix时检查实际优先级。不要用 `lsp.enabled=false` 冒充关闭整个诊断引擎，它可能回退到其他 checker。[官方配置说明](https://github.com/apmantza/pi-lens/blob/master/docs/globalconfig.md)

### 迁移验收

- 一个正常小修改不触发后台全仓扫描、自动测试、自动格式化或无关规则修复。
- 在已正确配置的 TS/Python 项目构造真实错误，按需诊断应能报告；缺服务/超时显示 unavailable，不标记为 clean。
- 日常搜索与小修改不用 LSP 也能完成；项目原生检查结果是收尾依据。
- 无 read_symbol/lens_diagnostics 等悬空指引；watchdog、undo、footer 不依赖 lens 才能工作。
- 比较冷启动、空闲进程数、diagnostics 输入量、任务总轮次及正确性；只减少工具数量不算验收完成。

## 4. 下一步补什么功能

| 顺序 | 功能 | 最小实现 | 验收 |
|---|---|---|---|
| P0 | 插件版本与补丁清单 | 统一记录精确版本、npm integrity、Pi/Node 版本、补丁 hash、验证日期 | 任意一台机器能重建相同组合；更新后桥接失效可见 |
| P0 | 收敛诊断与验证入口 | 执行上面的 lens 迁移；watchdog 监督需求与证据，原生命令验证代码 | 同一问题不被多套诊断重复刷屏，真实失败不会被吞掉 |
| P1 | 完成提示词去重 | 移除 tool-awareness 重复列表，精简 Plan/Build 和 todo/GUI 常驻 guidance | 保持可发现性，系统提示相对已保存基线减少；不新增一份长优化提示词 |
| P1 | 大输出落盘和定向取回 | 在现有输出文件、responseId 之上统一短索引；默认只回状态、关键头尾和引用 | 长日志末尾的真实错误可见；能找回完整原文；不会反复全文读取 |
| P1 | 任务交接 `/handoff` | 从当前分支生成短交接文件：目标、最终约束、已做/未做、证据路径 | 新会话按需读取后能续接，不重做已完成步骤；不自动污染 AGENTS.md |
| P2 | 健康检查与更新预览 | 扩展已有 `/health`，显示 installed/available/patch compatibility；只读检查 | 更新前可看到影响，用户未要求时不安装、不定时后台调用模型 |
| P2 | 验证证据完善 | 现有 ledger 加项目验证配方、证据版本和变更文件范围 | 失败/未知/过期分开，缺检查不等于检查通过 |

暂不增加向量数据库、跨项目自动记忆、第二套调度器、自动模型路由或全局自动修复。这些与当前“轻量、稳定、准确”的目标不匹配。

## 5. 跟上游更新，但不直接跟 latest 跑

### 运行版本与更新候选分开

- 运行配置使用精确版本；候选版本放独立清单，不把裸 npm 包名当成版本锁。
- 本次已将全部启用 npm 插件改成精确版本；候选通过 `/updates check` 单独检查，不直接改运行版本。
- npm integrity 用来验证下载包，安装后的必要补丁必须另记 hash；二者不能混为一谈。
- 对核心升级需同时记录 Pi CLI、SDK/TUI/AI 相关依赖及 Node；不能仅检查 peerDependencies 中的 `*`。

### 更新节奏

普通更新每两周集中评估一次是人工维护建议，不创建后台定时任务；安全、认证或 provider 兼容修复在需要时提前处理。一次只更新一组耦合组件，不把核心、LSP、子代理及 UI 同时全部升级。

升级流程：查看 release/changelog → 下载到隔离环境 → 检查配置与接口差异 → 重放补丁 → 执行关键回归 → 保存验收记录 → 切换运行配置 → 保留上一可用组合。预检失败就留在原版本，不能更新一半继续运行。

## 6. subagents 本地补丁的去耦

当前补丁脚本检查版本、固定 chunk 和原始内容 SHA256，再原子应用状态桥；健康检查核对安装后 hash。桥仍包装内部 runtime 方法，不是稳定的公开 API。重新安装同版本也可能覆盖补丁，因此“已锁版”本身并不足够。

1. 近期继续固定 0.84.0。健康检查验证补丁标记、目标文件 hash、可用状态快照、会话/审查 ID 关联，而不是只判断文件存在。
2. 把补丁基线与回归测试纳入本地版本清单，安装时先校验再原子替换，失败可回滚；不要仅用一次字符串匹配代表兼容认证。
3. 为上游整理最小接口需求：只读 watchdog 状态事件 + 当前快照查询，携带 sessionId/reviewId/epoch、模型/thinking、phase 和发现摘要；无需暴露私有提示词。
4. 上游有正式接口后切换适配层，并删除 chunk 补丁。没有时保留很薄、单版本的源码补丁，不长期 fork 整个 subagents。
5. UI 收不到可信状态就显示 `watch ?`；不影响原生监督运行，也不把缺少 telemetry 报成审查通过。

上游 CHANGELOG 已有未发布的工作流隔离/恢复等修改，说明不能无限停留旧版；但它们尚不是新的 npm release。后续应跟踪相关发布，再按兼容回归决定是否接入。[上游 CHANGELOG](https://github.com/nicobailon/pi-subagents/blob/main/CHANGELOG.md)

## 7. 本地维护方式

将本地扩展源码、测试、manifest 和补丁统一成一个可版本化的本地 package，运行时 state、auth、缓存、会话日志不进入源码包。不强行把所有扩展合并成一个大文件；保留独立模块，统一构建和测试入口即可。

`pi-agent-upgrade/` 现为 private 本地维护包：统一源码、测试、运行清单和补丁；`maintain.py` 提供幂等 install、verify、rollback、update-check，旧 install.py 转调同一安装器。运行目录仅部署源码，不再同时 pi-install 此目录。安装前需具备清单依赖；语言服务为本机路径，迁移机器时必须适配。

新增代码优先使用 Pi 公开 Extension API。遇到只能访问私有方法的需求，必须记录具体版本、替代路径和删除补丁条件。维护差异集中在布局、工作流约定与适配，不自行承担整个语言服务或 provider 协议。

## 8. 执行顺序与完成标准

1. **先做轻量诊断试运行**：隔离停用 lens，纯项目命令跑代表任务；必要时测试双工具 pi-lsp。只启用一个候选。
2. **固定运行组合**：把现有版本与桥接补丁记录完整，保持用户确认的默认模型、low 监督及七个压缩覆盖不变。
3. **完成提示词去重**：与迁移分开提交/验证，测工具发现和上下文体积。
4. **再补输出检索与 handoff**：复用现有存储和命令，不增加常驻大说明。
5. **验收更新机制**：用隔离候选升级演练一次，确认失败能恢复原组合，undo/redo 与状态栏没有回归。

最小回归集沿用已保存的 native-session、undo、footer、bridge、PDF、verification 和 pre-push 测试；新增“无 lens 的正常编辑”和“按需诊断真实错误”案例。补丁/配置变更先离线验证，实际模型准确率和性能评估单独记录调用成本，不把 stub 测试描述成线上效果。

完成标准：默认会话无无关自动诊断；需要时能定位/验证真实错误；提示词与空闲服务负担可测地下降；上游更新不会静默覆盖本地功能；出问题可回到上一可用组合。

## 9. 执行结果

- 已从默认配置停用 pi-lens，保留磁盘副本用于回滚；加入精确版本的按需双工具 LSP，复用现有 TS/Pyright 服务。关闭 watchdog 重复 LSP pre-pass，保留当前模型 low 监督。
- 常驻提示词去重；相同隔离 RPC 生命周期下系统提示从 17,059 字符降到 8,127（52.4%），活动工具从 26 个降到 21 个，Skill 从 9 个降到 5 个。字符数不等于实际 provider token 或任务准确率。
- 已补 `/outputs`、延迟发现的 `output_read`、`/handoff`、`/verification recipes`、`/updates`；长输出保留头尾和完整原文引用，不向主提示词加入长说明。
- 全部启用插件精确锁版；清单记录 integrity、Pi/Node/SDK 和源文件/补丁 hash。安装预检失败不改运行配置，回滚拒绝覆盖后续修改。registry 检查未发现启用插件的新发布版，未自动升级。
- undo/redo、真实 Pi 会话树、footer、监督桥、PDF、验证记录、推送检查及新功能回归通过；临时 TypeScript 项目按需诊断检测到预置类型错误；完整 SDK 加载无生命周期错误。
- 安装/幂等/补丁漂移拒绝/冲突保护回滚已在隔离目录演练。没有新上游版本时，仅验证未知候选拒绝路径，不冒充新版兼容认证。
- 保留 DeepSeek Flash 默认模型及七个 1M 模型 50% 压缩覆盖。没有模型调用；实际任务准确率、端到端速度及空闲资源基准尚未量化。
- subagents 公开状态接口需求已整理成本地文档，未对外发送；目前仍维护 0.84.0 薄补丁。

完整命令、实测限制和回滚说明见 [实施报告](/home/revy/minepi/pi-agent-upgrade/docs/LIGHTWEIGHT.md)，结构化结果见 [validation-lightweight.json](/home/revy/minepi/pi-agent-upgrade/validation-lightweight.json)。

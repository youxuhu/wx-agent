# 代码结构与运行机制

## 文件布局

| 路径 | 职责 |
|---|---|
| `extensions/<name>/index.ts` | Pi 自动发现的本地扩展入口；事件、工具、命令注册 |
| `extensions/checkpoint/engine.mjs` | Git 快照、私有 index、引用、锁及原子状态写入 |
| `extensions/runtime-support/index.ts` | 健康检查、有效配置、验证记录、输出检索、交接、更新预览 |
| `extensions/runtime-support/artifacts.mjs` | 完整输出保存/有界查询、无模型调用的交接文本生成 |
| `extensions/runtime-support/watchdog-bridge.mjs` | 当前模型 low 监督状态适配与过期结果过滤 |
| `scripts/maintain.py` | install / verify / rollback / update-check；事务部署与运行清单 |
| `scripts/patch-watchdog.py` | 仅对指定版本、原始 hash 的 subagents chunk 应用薄补丁 |
| `scripts/pre-push-check.py` | 扫描所有待推送提交，阻止已知凭据模式和敏感文件 |
| `scripts/install.py` | 旧入口，转调 maintain.py install |
| `scripts/test.py`、`tests/` | 离线回归；LSP、维护演练另有测试入口 |
| `config/` | 部署模板；pi-lsp.json 使用 PATH，本机路径在运行目录覆盖 |
| `settings.json` | 实际启用插件、默认模型、压缩及监督配置 |
| `patches/watchdog.json` | 固定版本/chunk/原始 SHA256 的兼容基线 |
| `runtime-package.json` | 维护包元数据与脚本说明；不是 npm 自动识别的 package.json |
| `skills/` | 按需加载详细工作流；不把开发文档整体加入提示词 |

## 扩展边界

| 扩展 | 主要职责 |
|---|---|
| checkpoint | 用户轮次的文件和会话同步 undo/redo，恢复原始输入 |
| llm-speed | 英文三行 footer、宽度适配、缓存统计和监督状态 |
| runtime-support | 证据和诊断入口，不执行隐式模型审计 |
| plan-switch | 简短 Plan/Build guidance 和运行时写入限制；Plan 禁用 LSP 修复 |
| tool-awareness | 空适配入口；不再重复注入工具列表 |
| computer-use | WSL/Windows/macOS 桌面适配；详细流程在 Skill |
| read-pdf / read-xlsx | PDF 渲染/缓存和表格读取 |
| sandbox / policy | 操作系统约束与工具调用规则；平台能力分别验证 |
| git-sync / git-status | 异步仓库同步与 Git 展示 |
| agent-presets / repo-init / file-tree / notify | 预设、项目初始化、文件浏览、通知 |
| piwebui | 单独的 Web/桌面项目；不属于本轮默认运行时改造，依赖和验证独立 |

## 关键事件与数据流

用户输入前建立轮次快照，agent_settled 后完成轮次。undo/redo 同时导航 Pi 会话树和恢复 Git 文件树；冲突时拒绝覆盖。不是旧版 git stash create 方案。新建文件会随轮次恢复，初始脏文件/暂存状态受保护。仅 Git 工作区支持文件回退；忽略文件、仓库外部文件、数据库/网络/GUI 副作用不回退；旧快照不迁移。

监督仍由上游 pi-subagents 执行。薄桥发布只读事件/快照，footer 按 session/review 标识过滤旧结果；没有可信状态显示 unknown，而非通过。补丁仍依赖内部打包结构，公开 API 提案尚未提交上游。

长文本 tool_result 保存原文，模型收到头尾和 ID，通过延迟发现的 output_read 按行/关键词取回。已有上游截断无法恢复。handoff 只组合当前分支、最近约束、todo、报告和证据，不把模型主张当成验证事实，也不保证无限历史完整保存。

验证记录根据实际工具结果保存退出码与 Git 树；文件变化后证据过期。未知退出码不等于成功。`/verification recipes` 只展示候选命令，不自动执行。

## 维护归属

上游负责 Pi 核心、provider、子代理调度、LSP 协议、搜索及交互插件；本地维护 undo 语义、英文布局、策略与薄适配。不要 fork 整套上游引擎。新增行为优先公开 Extension API；内部补丁必须同时记录版本、hash、测试和删除条件。

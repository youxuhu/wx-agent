# 开发与维护手册

## 开发流程

1. 在唯一源码 clone 修改 `extensions/<name>`；事件/工具使用 Pi 公共 API。保持常驻提示简短，详细说明写按需 Skill/文档。
2. 只给有状态、冲突、生命周期等关键行为补有意义的测试；普通文档修改不调用模型。
3. 执行相关测试和安装预检，确认模型/压缩/监督原策略未被覆盖。
4. 部署至本机运行目录，Pi `/reload`，再 `/health`。实际模型准确率需单独记录任务、成本和结果，不以离线 mock 代替。
5. 检查 diff、凭据及机器路径，提交并推送；其他机器拉取后按跨机器文档部署。

## 测试入口

```sh
python3 scripts/test.py
python3 tests/maintenance.py
node tests/light-lsp.mjs
python3 scripts/maintain.py verify --root "$HOME/.pi/agent"
```

脚本需要 node/python/git 在 PATH。第一项覆盖用户轮次 undo/redo、真实会话导航、footer、桥、PDF、证据、输出/交接、Plan 限制和推送扫描。maintenance 测试隔离演练幂等安装、未知补丁拒绝和回滚冲突。LSP 测试需真实语言服务及本地进程 IPC，使用临时项目，不调用模型。`PI_LSP_TEST_ENTRY` 可指定已安装 pi-lsp 的入口。

**路径解析**：测试共享 helpers.mjs 自动定位 Pi SDK/Jiti/TUI，可用 PI_CORE_DIR 指定特殊安装位置；PI_TEST_AGENT_DIR 指向测试依赖所在运行目录（默认 ~/.pi/agent）。LSP 测试默认加载该目录中已安装插件与本机配置，PI_LSP_TEST_ENTRY 可覆盖入口。维护演练仍需要已有精确版本包。measure.mjs 不再依赖临时目录，且拒绝重写历史 before 基线；实际模型/插件环境缺失仍需先配置。

`runtime-package.json` 仅是保留的包元数据：当前根目录并无受跟踪的 package.json，因此首选上述直接脚本，不宣称 clone 后 npm test 可立即运行。

## 精确版本和补丁

上游插件继续跟随发布，但运行配置不直接追 latest。每两周人工查看候选是建议，不是后台定时任务。`/updates` 看缓存；`/updates check` 或 `maintain.py update-check` 只读 registry，不安装。

升级一次一组耦合组件：隔离下载候选 → 阅读变更/peer 依赖 → 验证公开 API 和配置 → 重放补丁 → 关键回归 → 保存结果 → 切换版本 → 保留上一组合。RPIV 系列共同验证；Pi 核心需同时检查 pi-ai/pi-tui/pi-agent-core 与 Node。

subagents 当前仅支持 0.84.0 指定 chunk 和原始 SHA256。漂移被拒绝时，先确认上游变化，不删除 hash 校验硬套补丁。上游公开 watchdog 状态接口可用后，迁移桥并删除生成 chunk 补丁。`patches/WATCHDOG-API.md` 仅是本地接口提案，没有对外发送。

安装器生成的 maintenance-lock.json 记录本机版本/integrity、源码及补丁 hash。npm integrity 是下载包校验值，本地补丁另记 hash。verify 检查锁定项目的漂移，不是所有语义/配置正确性的证明；仍需 `/effective-config` 检查模型和压缩策略。

## 部署、冲突和回滚

```sh
python3 scripts/maintain.py install --root "$HOME/.pi/agent"
python3 scripts/maintain.py verify --root "$HOME/.pi/agent"
python3 scripts/maintain.py rollback --backup /absolute/path/to/rollback.json
```

install/rollback 使用同一目标目录的非阻塞操作系统锁防止并发。install 先汇总 Pi/Node/SDK、依赖 integrity、语言服务和目录可写性检查，在临时副本预检补丁，再备份并原子写文件；异常恢复已备份内容，重复同样安装不写新状态。rollback 会核对安装后的 hash；后续有人工修改则停止，先保存和合并差异，不强行覆盖。全新机器使用其自己的 rollback manifest，不能使用原开发机的备份路径。回滚后 Pi `/reload` 并复核健康状态。回滚不会撤销网络/GUI/数据库操作，也不卸载额外 npm 缓存。

## Git 发布

提交前查看 `git status`、`git diff --cached --check` 和暂存文件；auth、web-search.json、.env、私钥、机器状态及备份不提交。pre-push-check 扫描所有待推送提交，不仅最终工作树；早期提交泄漏后再删除仍会阻止推送。

Git hooks 不随 clone 自动安装。若要启用本仓库的 pre-push，在源码仓库 `.git/hooks/pre-push` 写入：

```sh
#!/bin/sh
exec python3 "$(git rev-parse --show-toplevel)/scripts/pre-push-check.py" "$@"
```

随后 chmod +x。已有 hook 应合并，不能覆盖。原开发机还有 post-commit 自动 push；建议其他机器默认手动 push。需要单次关闭该自动推送时用 `GIT_AUTO_PUSH=0 git commit ...`，再手动 git push；这不跳过 pre-push 检查。

## 常见故障

| 现象 | 处理 |
|---|---|
| watch ? / bridge unavailable | 核对 subagents 版本、chunk/hash、补丁及 reload；未知不等于审查通过 |
| LSP 无法启动 | 核对 config 与运行 pi-lsp.json、服务路径、node、项目根及 tsconfig |
| undo 不可用 | 确认在 Git 工作区、reload 后新轮次；后续文件冲突拒绝覆盖是预期保护 |
| 配置与 UI 不同 | 查看 /effective-config、项目 .pi/settings.json 及会话覆盖；reload |
| 输出不完整 | /outputs 和 output_read 查保存原文；上游先截断的部分无法找回 |
| runtime lock drift | 查清源码、依赖或逐机配置变化后再部署，勿直接改锁假装通过 |

运行日志、完整输出和 handoff 可能含私有项目内容；保留在本机，不附到公开 issue。详尽开发文档不应加入 AGENTS.md 常驻提示，只留短链接。

## 本轮可靠性修复

- backups/ 和 Python 缓存忽略；pre-push 同时拒绝待推送历史里出现过的备份目录，即使后来已删除。新增备份目录权限 700、备份文件权限 600。
- 运行 pi-lsp.json 为本机覆盖配置，不再提交；公共 config/pi-lsp.json 使用 PATH。已有配置不被部署模板覆盖。
- 安装器排除 node_modules、构建产物和独立 piwebui，避免把缓存和未纳管 Web 项目同步到运行目录。
- 输出检索流式读取、有界返回。单个输出最大 64 MiB；写入前检查现有 txt 文件数量（最多 1000 个）与总量（256 MiB），达到预算拒绝新增存储并保留原始工具结果，不自动清除会话引用。多会话同时写入可能短暂超出检查时预算；这是增长保护，不是文件系统硬配额。清理前请确认相关会话不再需要原文。
- handoff 显示原会话文件、分支叶节点及用户消息 entry ID；内容截断明确标记，长用户要求同时保留头尾，提醒回查原会话。
- Node 版本变化会由 verify 提示。特殊 Pi 包安装位置可设置 PI_CORE_DIR，必须指向真实 pi-coding-agent 包根目录。

本轮验收（2026-11-02，Linux/WSL、Pi 1.4.0、Node 22.23.2）：离线运行时回归、安装预检失败不写配置、并发锁、逐机 LSP 保留、幂等安装/漂移拒绝/回滚保护、备份历史拒推、流式输出与预算、交接截断来源标记均通过；真实临时 TS 类型错误诊断通过。SDK 生命周期无错误，系统提示仍为 8,127 字符；没有真实模型调用，未声称完成其他平台实机验收。

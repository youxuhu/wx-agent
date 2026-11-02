# wx-agent：Pi 本地扩展与配置

此仓库保存 Pi 的本地扩展、精确版本插件配置、维护脚本、测试和开发文档。当前验证组合为 Pi 1.4.0 / Node 22.23.2；运行时默认目录是 `~/.pi/agent`。不是发布到 npm 的插件整包，也不是可以无条件跨机器直接覆盖的用户目录。

## 从这里开始

- [代码结构与运行机制](docs/ARCHITECTURE.md)
- [跨机器部署与配置边界](docs/MULTI-MACHINE.md)
- [开发、测试、更新与回滚](docs/MAINTENANCE.md)
- [轻量化实施结果与验证边界](docs/LIGHTWEIGHT.md)
- [选型与维护计划](docs/PLAN-plugin-maintenance.md)
- [监督状态公开接口提案](patches/WATCHDOG-API.md)

当前默认模型为 DeepSeek Flash；仅配置中的七个百万上下文模型使用 50% 压缩覆盖。监督跟随当前模型，thinking=low。pi-lens 已停用，按需 `@narumitw/pi-lsp` 替代；没有编辑后自动全仓诊断。常驻提示保持精简，开发文档不自动注入模型。

常用入口：`/undo`、`/redo`、`/plan`、`/build`、`/health`、`/effective-config`、`/verification`、`/outputs`、`/handoff`、`/updates`。修改扩展后 `/reload`。

仓库不包含鉴权、模型清单、会话、机器信任、语言服务二进制、npm 安装目录、验证记录和回滚备份。不要把整个旧机器用户目录提交或覆盖到新机器。旧版 README 中“依赖已随仓库同步”和“models.json/trust.json 已跟踪”的描述已作废；以 `.gitignore` 和跨机器文档为准。

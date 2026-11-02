# 跨机器部署

这是受控迁移流程，不是“一条命令完整重建”。核心和测试路径已自动解析；语言服务仍需逐机安装并配置。不要在已有 `~/.pi/agent` 上直接 clone/覆盖。

## 1. 准备独立源码与逐机依赖

```sh
git clone https://github.com/youxuhu/wx-agent.git ~/src/wx-agent
cd ~/src/wx-agent
npm install -g @earendil-works/pi-coding-agent@1.4.0
node --version
pi --version
```

当前参考 Node 22.23.2、Python 3、Git、rg。macOS PDF 使用系统 Swift/PDFKit；Linux/WSL 需要 poppler-utils（pdftoppm）。Excel 需要 xlsx；sandbox 需要 @anthropic-ai/sandbox-runtime，其 node_modules 没有提交，按扩展 README 安装并验证系统支持。依赖安装目录和版本以实际导入解析为准；不要复制其他机器的 node_modules。

## 2. 创建运行目录并安装精确插件

先备份已有运行目录。新机器可创建 `~/.pi/agent`，将源码 `settings.json` 复制过去作为初始配置（已有机器则手动合并，别覆盖个人设置）。根 settings.json 若有旧 deviceId 请删除，让 Pi 生成本机标识；config/settings.json 模板不含 deviceId。安装模板 packages 中逐个完整的 `npm:名称@版本`：

```sh
pi install npm:pi-web-access@0.46.0
pi install npm:@juicesharp/rpiv-todo@2.15.0
pi install npm:pi-subagents@0.84.0
pi install npm:@juicesharp/rpiv-ask-user-question@2.15.0
pi install npm:@narumitw/pi-btw@0.63.3
pi install npm:@narumitw/pi-lsp@0.49.11
```

不要用裸包名或无范围升级代替。包管理器可能处理 peer 依赖，核对没有意外换掉核心/SDK。认证、DeepSeek key、models.json 与联网搜索配置逐机创建；此仓库不包含它们。自定义 provider 不存在时，单复制默认模型名不能使其可用。

## 3. 适配路径，然后部署

`config/pi-lsp.json` 默认从 PATH 查找 typescript-language-server / pyright-langserver。安装所需语言服务及 TypeScript；不需要的语言从配置删去。也可在目标 `~/.pi/agent/pi-lsp.json` 写本机绝对路径和 tsserver 路径。安装器优先保留目标已有配置，新机器没有该文件时才使用模板；预检会核对服务命令、显式 JS 入口和 tsserver 文件。不要将逐机路径写回公共模板。本机仍可继续使用 ~/.pi-lens/tools 中的旧服务，无需启用 lens。

检查 computer-use 的系统后端、桌面权限；sandbox/policy 的路径和网络规则逐机配置，不关闭安全限制来绕过配置错误。保留个人配置适配在本地，不提交凭据。

```sh
cd ~/src/wx-agent
python3 scripts/maintain.py install --root "$HOME/.pi/agent"
python3 scripts/maintain.py verify --root "$HOME/.pi/agent"
```

安装器只部署本地源码/配置并应用补丁，不安装缺失 npm 包；要求目标 settings.json 和指定插件已存在。它仅合并 packages/defaultTools/codemode 和 watchdog.lsp，**不会自动补齐已有机器全部模型/压缩/监督设置**，这些需与 settings.json 模板人工比对。XDG guidance 默认写 `~/.config/rpiv-*`，可用 `--xdg` 指定。源码与运行目录应分离；不要同时 `pi install` 本仓库造成双重加载。

安装输出回滚 manifest 的位置必须保存；备份存在源码目录 backups/，不要提交。新机器安装后生成本机 maintenance-lock.json，不复制旧机器的文件 hash 清单。进入 Pi 执行 `/reload`、`/health`、`/effective-config`，确认当前模型/上下文窗口符合配置，再测试一个临时 Git 项目的 undo/redo。

## 4. 同步策略和边界

推荐独立源码 clone；git-sync 扩展只管理运行目录自身的 Git 仓库，不会自动同步外部源码。更新源码后先验证再部署。运行目录若也是 clone，不要同时维护两份分叉源码；明确以哪个 clone 为准。

| 可同步 | 每台机器独立 |
|---|---|
| 扩展、测试、补丁、文档、无密钥配置模板 | auth、web-search key、models、trust、sandbox 路径、deviceId |
| 插件精确版本要求 | npm/、语言服务、平台依赖 |
| 维护策略 | sessions、checkpoint-v2、verification、outputs、handoffs、缓存、备份、maintenance-lock |

测试通过 helpers.mjs 自动定位 Pi SDK/Jiti/TUI，不再绑定原开发机路径或临时候选包。特殊安装可设置 PI_CORE_DIR；测试运行目录可用 PI_TEST_AGENT_DIR 指定，LSP 测试使用该目录的 pi-lsp.json。measure.mjs 仍依赖实际安装插件及模型环境，不是独立通用基准。不能将这套文档理解为已在 Windows 原生、macOS、所有 Linux 发行版全面验收。

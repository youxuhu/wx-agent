# pi-config

本仓库是 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（pi coding agent）的**本机配置 + 本地扩展源码**，用于在多台机器之间同步扩展与设置。

仓库**只跟踪扩展源码与少量可同步配置**；会话日志、鉴权、缓存、模型清单等机器本地内容一律不同步（见 `.gitignore`）。

## 目录结构

```
~/.pi/agent/
├── extensions/          # 本地扩展：每个子目录一个 index.ts，pi 自动发现（改完 /reload 热重载）
│   ├── agent-presets/   # 每个扩展自带 README.md，记录契约与坑
│   ├── sandbox/         # 含 node_modules（@anthropic-ai/sandbox-runtime），随仓库同步
│   └── ...
├── settings.json        # 全局设置，packages 字段声明 npm 插件
├── models.json          # 模型/供应商声明（本仓库跟踪）
├── trust.json           # 目录信任（本仓库跟踪）
├── sandbox.json         # 沙箱策略（gitignored：逐机，含本机路径）
└── (gitignored)         # sessions/ npm/ web-search-cache/ missions/ auth.json* models-store.json
```

## 安装与同步

```bash
git clone <this repo> ~/.pi/agent
pi update --extensions        # 安装/更新 settings.json 中声明的 npm 插件
pi list                       # 复核已装插件
```

逐机依赖（不进仓库，装一次即可）：

| 需要 | 命令 |
| --- | --- |
| `read-xlsx` 的表格解析 | `npm i --prefix ~/.pi/agent xlsx` |
| `sandbox` 的内核沙箱运行时 | 已随仓库同步（`extensions/sandbox/node_modules`）；重建：`npm i --prefix ~/.pi/agent/extensions/sandbox` |
| `computer-use` 系统权限 | 系统设置 → 隐私与安全性 → 授予**辅助功能** + **屏幕录制** |

`git-sync` 扩展负责本仓库自身的同步：启动时**异步** `git fetch`（不阻塞启动），远端领先时询问一次是否 fast-forward；会话结束时**只推送已存在的提交**（从不自动 commit / pull）。

## 插件清单

### npm 插件（6 个，声明于 `settings.json` → `packages`）

| 插件 | 作用 |
| --- | --- |
| `pi-web-access` | 联网：`web_search` / `source_check` / `fetch_content` / `get_search_content`，`/websearch` |
| `pi-subagents` | 子代理与多 agent 工作流：`subagent` 工具，`/council`、`/parallel-review`、`/subagents-fleet`，skills `council-mode`、`pi-subagents` |
| `pi-lens` | 编辑时体检与导航：LSP 诊断、`symbol_search` / `module_report` / `project_report` / `read_symbol`、ast-grep 与 tree-sitter 规则 |
| `@juicesharp/rpiv-todo` | 任务列表：`todo` 工具，`/todos` |
| `@juicesharp/rpiv-ask-user-question` | 结构化提问：`ask_user_question` 工具 |
| `@narumitw/pi-btw` | 旁路提问（不打断主线）：`/btw` |

### 本地扩展（15 个，`extensions/*/index.ts`）

| 目录 | 工具 / 命名空间 | 命令 | 作用 |
| --- | --- | --- | --- |
| `sandbox` | — | `/sandbox` | **OS 级沙箱**（v2）：内核强制 bash 及全部子进程的 fs/网络策略 |
| `policy` | — | `/policy` | 权限规则 + 审计：调用前 allow / ask / deny，含 **auto/normal/strict 模式** |
| `checkpoint` | — | `/rewind` | 每轮 `git stash create` 快照 + 代码/对话回退（回退本身可逆） |
| `notify` | — | `/notify` | pi 停下等输入时桌面通知 + 提示音，通道按终端自适应 |
| `computer-use` | `computer` / `computer-use` | `/cua` | 桌面 GUI 自动化：截图 / 点击 / 输入 / 激活窗口，分级观察省 token |
| `agent-presets` | `preset` | — | 把多角色协作固化成预设数据，由 main 自己调用（5 个内置预设） |
| `plan-switch` | — | `/plan` `/build` `/plan-edit` | plan（只读，只能写 PLAN.md）⇄ build（全工具）角色切换，alt+tab |
| `repo-init` | — | `/init` `/repoinit` | 扫描仓库起草根目录 `AGENTS.md`（空目录直接生成空白模板） |
| `file-tree` | — | `/file` | 按需弹出的左侧文件树，选中文件用**外部 vim** 打开 |
| `git-status` | — | `/git <args>` | 状态栏 git 段（`⎇ main +1 ~2 !3`）+ git 直通命令 |
| `git-sync` | — | `/git-sync` | 本仓库的后台 fetch / 退出推送 / 手动同步一轮 |
| `llm-speed` | — | `/speed` | 统计行显示输出速度（tok/s），按档位着色 |
| `read-pdf` | `read_pdf` / `pdf` | — | 多模态读 PDF：系统 PDFKit 渲染成 PNG 图片块（零外部依赖） |
| `read-xlsx` | `read_xlsx` / `xlsx` | — | 读 Excel：SheetJS 转 markdown 表格（跳过 sheets 用 `sheet` 参数） |
| `tool-awareness` | — | — | 把扩展注册的工具以**一行索引**注入系统提示（长文档留在各工具命名空间） |

> 详细状态、实测证据与逐项说明见项目侧 `docs/pi-plugins-status.md`（维护在本仓库之外的工作区）。

## 安全与可逆设计

- **沙箱管效果，policy 管意图**：内核沙箱无法询问（只能拒绝），所以"逐次审批"由 `policy` 承担；两者不重复实现同一件事。
  - `sandbox.json`：`{enabled, network{allowedDomains,deniedDomains,allowLocalBinding,allowMachLookup}, filesystem{denyRead,allowWrite,denyWrite}, unsandboxedCommands}`
  - `policy.json`：`{mode, rules[]}`，顺序 **deny > ask > allow > 默认放行**
- **`unsandboxedCommands`（受控例外）**：默认 `["screencapture"]`。macOS 从不把录屏（TCC）授权给 seatbelt 进程，沙箱内 `screencapture` 必然失败——列在这里的命令**在沙箱外执行**，命中时每会话上报一次事实，不静默。管理：`/sandbox allow-unsandboxed <子串>` / `deny-unsandboxed`。
- **`policy` 模式**：`/policy mode auto|normal|strict`。`auto` 下 ask 规则自动放行（仍写审计），`strict` 下连"无规则命中"的调用也询问；`deny` 任何模式都成立。审批弹窗本身就是四选一：`Allow once` / `Always allow: <确切命令>` / **`Switch to auto mode`** / `Deny`。
- **回退可逆**：`/rewind` 在恢复前先给当前状态打快照，所以回退可再回退；回退不会删除后加的文件，只把残留差异作为事实报告。

## 配置文件速查

| 位置 | 用途 |
| --- | --- |
| `settings.json` | 插件声明（`packages`）、全局设置 |
| `sandbox.json` / `policy.json` / `notify.json` / `computer-use.json` | 逐机状态与策略（前两者在本仓库中被 gitignore） |
| `policy-audit.log` | policy 每次决策一行：`时间 \| tool \| 摘要 \| 决策 \| 命中规则 \| 来源` |
| `checkpoints.json` | 快照索引（保留 50 条，同 ref 去重） |
| `sessions/<项目路径>/` | 会话日志（不同步） |

## 已知坑

- **验证沙箱/代理类功能必须异步执行**：沙箱的 MITM 代理跑在宿主进程内，用 `spawnSync` 同步跑被沙箱命令会阻塞宿主事件循环，所有经代理请求看起来都超时（曾据此误判"网络层不可用"）。
- **沙箱内截图不可用**：见 `unsandboxedCommands`；`computer-use` 的截图在进程内完成，不受影响。
- **policy 规则锚定**：默认 deny/ask 模式锚定命令边界（`^` 或 `;` `&` `|` 之后），否则 heredoc/字符串里出现 `rm -rf` 这类字面文本会误杀自己。
- **`git stash create` 在干净树返回空**：`checkpoint` 因此回退到 `HEAD` 作为恢复点（`kind:"clean"`）。
- **esbuild 定位**：`@esbuild/darwin-arm64/bin/esbuild` 直调才能看到报错（npm 包装器会吞 stderr）。校验扩展：`esbuild extensions/<name>/index.ts --format=esm --outfile=/dev/null`。
- **pi 包在 CJS 里不可 require**：单测 bundle 需要 `--external:@earendil-works/pi-coding-agent`（或 esbuild `--alias` 到 shim）；`@earendil-works/pi-ai` 无 CJS 导出时同理 alias 一个 shim。

## 约定

- 扩展放 `extensions/<name>/index.ts`，pi 自动发现；**改完需 `/reload` 生效**。
- 子代理名、角色名、预设名、工具名**一律英文**；面向人的文案与文档用中文。
- 每个扩展自带 `README.md`：契约、配置、命令、已知限制。
- 项目侧的变更记忆写在目标项目根目录的 `AGENTS.md`（build 角色收尾时追加一行目的 + 一行做法，遇到的坑记一条短 bullet）。

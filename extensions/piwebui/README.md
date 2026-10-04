# piwebui — 本地 Web UI（Vue 3 + TS + Pinia，Codex 风格自绘 CSS）

在浏览器里跑一个 pi 会话：流式对话、工具卡片、扩展审批弹窗（policy 的四选一），
后续加浏览器预览面板（iframe + 元素拾取）。

## 凭据配置（settings 里的 `/login` 等价物）

`Settings` 抽屉 → **Providers & credentials**：

- 列出 `<agentDir>/auth.json` 里已配置的 provider 及类型（`api_key` / `oauth`），以及是否有值——**密钥值永远不会回传到浏览器**（探针里用真实 auth.json 的内容做过泄漏断言）。
- 可以**设置/轮换 API key**（写 `auth.json`，原子写 + `.bak` + 权限 0600）、**移除**某 provider 的凭据（直接点即确认删除）。
- **OAuth 类型（如 openrouter）不能在这里覆盖**：需要终端里 `pi` 的 `/login <provider>`（我们跑不了交互式 OAuth 流程），界面会明确这么告诉你；环境变量也是可行的替代。
- 同一页还有 **Default model**：写 `settings.json` 的 `defaultProvider` / `defaultModel`，新会话生效。

## 桌面版（Tauri）

打包成 macOS app，**内嵌** Node 运行时与精简后的 pi，不依赖系统装了什么：

```bash
npm run desktop:prepare   # 组装 desktop/resources（首次会下载 Node 49.9MB）
npm run desktop:verify    # 自检：裁剪运行时能否起 pi + 所有扩展能否加载
npm run desktop:build     # 出 .app 与 .dmg（需要 Rust 工具链在 PATH）

# 重新安装（覆盖 /Applications 里的旧版并重启）
pkill -f "Applications/pi agent.app"; \
  python3 -c "import shutil; shutil.rmtree('/Applications/pi agent.app', ignore_errors=True)"; \
  ditto "desktop/src-tauri/target/release/bundle/macos/pi agent.app" "/Applications/pi agent.app" && \
  open -a "/Applications/pi agent.app"
```

| 项 | 实测 |
| --- | --- |
| `pi agent.app` | **162.9 MiB**（Node 112MB + pi 运行时 76MB + web 156KB + server.mjs 200KB） |
| `pi agent_0.1.0_aarch64.dmg` | **48.2 MiB** |
| 启动 | Tauri 壳 → 打包内 `node` → `server.mjs --port 0`（系统分配端口）→ 从就绪行读回端口 → 窗口加载 `http://127.0.0.1:<port>/` |

要点：窗口里加载的仍是**我们自己服务提供的 UI**（同源），所以预览 iframe、元素拾取、审批弹窗全部照旧；关窗时壳会终止服务，服务再收掉所有 pi 子进程与 dev server。未签名，首次打开需右键 → 打开。

维护/排障/打包细节：见 **`MAINTENANCE.md`**（本目录）。

## 架构

```
浏览器 (Vue 3 + Pinia + 自绘 CSS，无组件库)
   │ WebSocket /ws
   ▼
Node 服务 server/main.ts (仅绑 127.0.0.1，默认 7799)
   │ JSONL stdin/stdout
   ▼
pi --mode rpc (受管子进程)
```

- 浏览器**不直连** pi：审批、状态、事件都经本服务，便于集中执行 invariant。
- 协议：pi 的 RPC（JSONL 命令 + 响应 + 会话事件 + extension UI 记录），参考 pi 安装目录
  `docs/rpc.md`、`docs/rpc-commands.md`、`docs/rpc-extension-ui.md`。

## 用法

```bash
npm install                        # 运行依赖只有 vue / pinia / ws
npm run build                      # 前端 → dist/
node server/main.ts --port 7799 --cwd /path/to/project \
  --model deepseek/deepseek-flash --thinking low
# 浏览器打开 http://127.0.0.1:7799
```

开发探测（不经过浏览器，直接验证桥）：

```bash
node probe/ws-probe.ts "reply with exactly: pong" --seconds 90
```

## 界面（对齐 Codex Web，自绘 CSS）

**组件库已弃用**：`@pixelium/web-vue` 从依赖里移除，改用一份设计令牌 + 原生控件（`web/src/styles/app.css`）。产物从 CSS 260KB/JS 266KB 降到 **CSS 7.6KB / JS 137KB**。

布局（Codex Web 的信息层级）：

```
┌ 顶栏：☰ · 工作目录 · 连接/pi 状态 · 审批数 … Files Changes History Branches Preview Settings
├ 左侧栏（可折叠）：New session · Open folder… · Sessions 列表（标题 + 时间 + 条数）
└ 中线：对话流（用户块 / 助手文本 / 折叠的 thinking / 工具卡）
   └ 底部：圆角输入框 + Send/Stop；其下一行 steer 开关 + 页脚事实（tokens/cost/context/扩展状态/模型）
右侧抽屉（默认收起）：files · changes · history · branches · preview · settings
```

- **只用原生控件**：前面 `pick element` 与 `ignored` 两个开关点不动，根因是它们被组件库的 `Tooltip` 包了一层（点击被包裹层吃掉/不可交互）；现在全是 `<input type="checkbox">`、`<select>`、`<button>`，无障碍树里可直接命中。
- 视觉：1px 浅灰描边、白底、无像素字体、无 emoji、系统字体栈，等宽字体只用于路径/命令/diff；正文 15px，次要 13px，辅助 12px。
- 只浅色：`html.className = "light"` + `color-scheme: light`，没有深色分支。
- 顶栏只有一个**健康指示**（`web/src/health.ts`）：把"浏览器↔服务 WebSocket"与"pi 子进程状态"合成一句。正常时只显示绿点 `connected`；异常时点名具体问题——`service closed — retrying in 4s`、`service error`、`pi exited (1)`、`pi stopped`、`connecting…`。底部状态行不再重复连接状态。

## 会话列表与切换

**入口**：`control` 抽屉 → `session` 页（标题栏不再单放按钮）。里面是：`new session` / `refresh list` / `compact` / 重命名 / 当前会话名与路径 / 本目录会话列表（`current` 与 `switch`），同一页往下还有统计、会话树、fork、clone、export、最后一条助手文本。

`/api/sessions`（以及 WS 的 `list_sessions`）从磁盘读当前 cwd 的会话文件（pi 存于
`<agentDir>/sessions/<cwd 编码>/<时间戳>_<id>.jsonl`；编码为 `--` + 去掉前导 `/` 并把 `/`→`-` + `--`，
cwd 先做 realpath，故 `/tmp` 落到 `--private-tmp--`）。列表包含：名称（`session_name` 条目）、
首条用户提示、消息条数、大小、时间。

- **切换**：WS `{type:"switch_session", path}` → 子进程 `switch_session`；成功后自动
  `get_messages` + `get_state` + `list_sessions` 重新水合界面。
- **重命名**：WS `{type:"set_session_name", name}`（名称来自 `get_state.sessionName`）。
- **invariant**：只允许切换到**当前 cwd 会话目录内**的 `.jsonl`；其他路径一律拒绝并报事实。
- 界面：标题栏 `sessions` 按钮打开抽屉，行内显示 `current` / `switch`、时间、条数、大小与首句。

## 工作目录（多 workspace）

标题栏上的 `folder · <路径>` 按钮 → 打开文件夹对话框：

- **浏览**：`/api/fs` 只列目录（+ 符号链接），且只允许 `$HOME` 与 `/tmp` 两个根内（越界拒绝并说明）；也可以直接粘贴绝对路径。
- **打开/切换**：`open_workspace` / `switch_workspace` / `close_workspace`（WS）。每个 workspace 有**自己的 `pi --mode rpc` 子进程**（cwd = 该目录），因此会话列表、preview 配置、git 状态都随目录走。
- **单写者 invariant**：同一时刻只有一个 workspace 是 `active`，只有它能接 `prompt` / `bash` / `set_*` / 会话切换等写操作；其它 workspace 的子进程保留、**只读观察**（发写命令会被拒绝并报出当前 active 是谁）。切走时未决审批仍留在原 workspace，对话框里显示其数量。
- 最近打开列表存在 `<agentDir>/piwebui-workspaces.json`。
- 启动参数仍是 `--cwd`（默认工作目录）；也可以 `?dir=<绝对路径>` 让某个标签页直接开在指定目录。

## 左侧栏：files / changes / history / branches

标题栏或侧栏顶部切换，可折叠（再点一次收起）。

| 页 | 内容 | 端点 |
| --- | --- | --- |
| `files` | 只读项目树（懒加载子目录、`.gitignore` 项默认隐藏可切换显示、`.git` 不展开）、git 状态字母、点击文件看内容（文本，带语言提示） | `GET /api/tree` `GET /api/file` |
| `changes` | 分支 + ahead/behind、暂存/未暂存/未跟踪三组、逐文件 `stage`/`unstage`/`discard`、diff（行级着色）、commit（只提交已暂存，`amend` 需单独开关） | `GET /api/git/status\|diff\|numstat`、`POST /api/git/stage\|unstage\|discard\|commit` |
| `history` | 提交列表（hash / subject / ref 标签 / 时间），点一条看完整 `git show`（含 `--stat`） | `GET /api/git/log` `GET /api/git/show` |
| `branches` | 本地/远程分支、当前分支、切换、新建并切换 | `GET /api/git/branches`、`POST /api/git/checkout\|branch` |

**文件面板这轮只读**：没有写文件的代码路径（预览走同一套只读 API）。

### Git 红线（代码强制，做到或明确报不支持）

1. **没有 force-push / merge / reset --hard / clean -fd / rebase 的 argv 路径**（probe 会静态扫源码断言）；
2. push 与 PR 本轮**未实现**（连按钮都没有）；
3. **discard 必须先确认**（对话框）且服务**先落快照** `refs/piwebui/<时间戳>`，快照 ref 会作为事实回传（探针会 `git rev-parse --verify` 复核它真的存在）；未跟踪文件**拒绝**丢弃（删未跟踪文件等于 `git clean`，无此代码路径）；
4. 切分支时工作树脏 → **拒绝**并列出脏文件；
5. 前端**不能传 argv**：每个动作在 `server/git.ts` 里拼参数；路径一律先 realpath 包含校验（越界拒绝）；
6. git 读操作 `GIT_OPTIONAL_LOCKS=0`（不写 index）、`GIT_TERMINAL_PROMPT=0`（不阻塞要凭据）、15s 超时；写操作按仓库**串行**；
7. 失败/冲突原文回传，不重试、不假装成功；冲突文件以 `UU` 状态如实展示（本轮不提供 ours/theirs 解决）。

## 文件面板：markdown 渲染

`files` 抽屉里点开 `.md / .markdown / .mdx` → 顶部有 **Rendered / Raw** 切换，默认渲染：

- 自研**无依赖**渲染器（`web/src/markdown.ts`，约 150 行）：标题、粗体/斜体/删除线、行内代码、围栏代码块、有序/无序列表（含嵌套）、引用、分隔线、表格、链接。
- **安全模型**：源码先整段 HTML 转义，输出里只会出现渲染器自己写的标签；链接只允许 `http/https/mailto/相对路径`，`javascript:` / `data:` 一律改写成 `#`；图片降级成 `[image: alt]` 文本（不发起任何外部请求）。所以 `v-html` 在这里是安全的——探针里专门用 `<script>`、`<img onerror>`、`javascript:` URL 三种注入样本验证过。
- 其余文件仍是纯文本预览（>2MB 与二进制在服务端就被拒绝）。

## 右侧抽屉：可调宽度

抽屉左边缘是分隔条（`role="separator"`）：

- **拖拽**调整宽度（320px ~ 窗口宽-380px）
- 键盘可达：聚焦后 `←` / `→` 每次 ±24px，`Home` 或双击复位到 460px
- 宽度存在 `localStorage`（`piwebui.drawerWidth`），刷新后保持

## 深链

`?dir=<绝对路径>` 直接开在指定工作目录；`?file=<绝对路径>` 直接打开 `files` 抽屉并渲染该文件（markdown 会渲染）。例：`http://127.0.0.1:7799/?file=/Users/revy/project/minepi/PLAN.md`

## 状态栏（把终端页脚搬到浏览器）

底部一行复刻终端页脚的信息，全部来自真实上报：

| 段 | 来源 |
| --- | --- |
| `↑in ↓out R(cache read) W(cache write) CH% $cost` | `get_session_stats.tokens/cost`（**会话累计**，与终端页脚同源）；统计未到时回退到实时 `usage`（`message_update` / `turn_end`） |
| `CH%` | `cacheRead / (input + cacheRead + cacheWrite)`（与 `llm-speed` 的实现同式） |
| `x%/window` | `get_session_stats.contextUsage`（pi 的压缩估算；压缩刚结束时 `percent`/`tokens` 为 `null`，如实显示 `?`） |
| `N t/s` | 浏览器自己按相邻两次 usage 报告的 output 增量 ÷ 时间算（同样的定义、带平滑） |
| `policy:auto`、`⎇ branch`、`LSP Active: …`、`Sandbox: …` | 扩展的 `setStatus` 单向记录（**ANSI 颜色码会剥掉**，否则页面上是乱码） |
| 右侧 `provider/model • thinking` | `get_state` |

刷新时机：连接时、`turn_end`、`compaction_end`、`agent_settled`。连接时也会拉一次 `get_messages`，所以**刷新页面不会丢对话**。

**已知限制**：`setStatus` 是单向推送，RPC 没有"读取当前状态"的命令 → 页面刷新后这些扩展状态会空着，直到该扩展再次上报（在终端或 control 抽屉里触发一次 `/policy status`、`/git` 等即可）。

### 在浏览器里发 `/xxx` 会发生什么

pi 的**内置 TUI 命令**（`/model` `/settings` `/hotkeys` `/login` `/reload` …）不在 `get_commands` 里，经 `prompt` 发送也不会被执行——会被当普通文本发给模型。浏览器会为此显示一条 notice 说明事实，并把模型/思考/会话指向 control 抽屉；可枚举的命令（扩展命令 / 模板 / 技能）才真正执行。

## 控制面（把 TUI 能干的事搬到浏览器）

标题栏 `control` 按钮 → 右侧抽屉，五个分页，全部是**真实 RPC 命令**，没有假按钮：

| 分页 | 能力 | 走什么 |
| --- | --- | --- |
| `commands` | 枚举 pi 当前会话里全部可调用命令（扩展命令 / 提示模板 / 技能），点击把 `/name ` 放进输入框 | `get_commands`；执行 = `prompt` 发 `/name`（pi 文档：扩展命令经 prompt 立即执行） |
| `model` | 当前模型 / 思考等级、循环切换、可用模型与思考等级列表、auto-compaction、auto-retry（+abort retry）、steering / follow-up 队列模式 | `get_available_models` `set_model` `cycle_model` `get_available_thinking_levels` `set_thinking_level` `cycle_thinking_level` `set_auto_compaction` `set_auto_retry` `abort_retry` `set_steering_mode` `set_follow_up_mode` `get_state` |
| `session` | 统计（token/成本/上下文）、会话树、fork 点与 fork、clone、export html、最后一条助手文本 | `get_session_stats` `get_tree` `get_fork_messages` `fork` `clone` `export_html` `get_last_assistant_text` |
| `shell` | 直接执行 shell（等价 TUI 的 `!`），输出流式显示，可 abort，可 exclude from context | `bash`（`bash_execution_update` 流式事件）+ `abort_bash` |
| `config` | 读写 pi 的配置文件 | `GET/PUT /api/config` |

**配置写入的规则**：只允许白名单（`settings.json` / `models.json` / `policy.json` / `sandbox.json` / `notify.json` / `computer-use.json` / `checkpoints.json` / `preview.json` / `trust.json`）；**`auth.json` 永不暴露**；保存前校验 JSON，失败拒绝；写入是「先写 `.tmp-<pid>` 再 rename」，旧内容保留为 `<file>.bak`；返回里明确写「写盘了，但扩展是加载时读配置 → 需终端 `/reload` 或重启才生效」。

**RPC 白名单**：浏览器能触发的命令在服务端 `RPC_PASSTHROUGH` 表里逐条列出**允许字段与必填字段**，表外的（如 `login`）一律拒绝并回原文；缺必填字段直接在服务端拒绝，不发给 pi。

### 与 TUI 的真实差距（不可达的部分）

pi 的**内置 TUI 命令**不在 `get_commands` 里，文档明确"经 prompt 发送也不会执行"。因此 `/settings`（交互设置界面）、`/hotkeys`、`/login` `/logout`、`/llama`、`/share`、`/bug`、`/trust`（交互确认）、`/reload` 在 Web UI 里**没有等价物**——除 `/reload` 外都不影响日常使用；改完配置需要在终端敲一次 `/reload`。其余 TUI 能力（模型/思考/压缩/重试/队列模式/会话切换/命名/分叉/克隆/导出/统计/命令/shell）都已在浏览器里可用。

### 验收

桌面版重装步骤（app 必须先关掉）见 `MAINTENANCE.md`。

`npm run typecheck` 用 **vue-tsc**（模板也查类型）；离线探针 `probe/message-probe.ts` 覆盖消息块渲染。

`node probe/control-probe.ts` → **21/21**：命令枚举与执行（`disposition: "handled"`）、模型/思考等级、设置往返、会话统计/树/fork 点/最后助手文本、`bash` 真执行 + 流式事件、未知命令与缺字段拒绝、配置白名单/JSON 校验/原子写 + `.bak`、`auth.json` 不暴露。

## 预览面板（P3）

标题栏 `preview` 按钮打开右侧面板：`iframe` 指向**同源代理** `/__proxy/`，前面是我们自己起的本地 dev server。

- **工具条**：地址栏（`http://127.0.0.1:<port>/…`、`/path`、`file:///abs/path`）+ `go` + `reload` + 前进/后退 + 视口宽度（375 / 768 / 1280 / full）+ `pick element`。
- **代理改写**：HTML/CSS 会被改写（`src|href|action|poster` 的根相对路径、`url(/…)` 前缀加 `/__proxy`），并把**拾取脚本**注入 `<head>`；JS/JSON/二进制**原样透传**。上游收到的请求带 `accept-encoding: identity`。
- **CSP 冲突如实上报**：响应里的 `content-security-policy` / `x-frame-options` 会被剥掉（否则注入脚本与 iframe 都用不了），并在响应头 `x-piwebui-csp-relaxed` 上标明"已放宽以注入拾取脚本"。
- **元素拾取**：注入脚本采集 `{url,title,tag,role,id,classes,text,rect,selector,selectorMatches,selectorUnique,html(≤1KB，去 script/style/内联事件)}`；点击后经 `postMessage`（父窗口校验 `event.origin`）进面板批注列表。选择器优先 `#id`（唯一时），否则 `tag:nth-of-type(n)` 逐级上溯，并在页面内用 `querySelectorAll` **复核唯一性**（面板显示 `unique` 或 `N matches`）。
- **批注 → 提示词**：每条可写备注，`insert` / `insert all into prompt` 把结构化事实追加到输入框（只给事实，不含任何建议动作）。
- **dev server 生命周期**：`start dev` / `stop` / 状态（`stopped|starting|ready|failed|exited`）+ 输出尾部。就绪判定 = 配置端口被 HTTP 真实应答（或 `readyPattern` 命中），超时/退出原文回传、**不重试**。
- **`file://` 只读预览**：`/__file/?path=<绝对路径>`，仅限配置的 `root` 内（`realpath` 校验，`..` 穿越一律 403），响应带 `x-piwebui-readonly: 1`。

### `preview.json`（配置目录下，默认 `~/.pi/agent/preview.json`）

```json
{
  "projects": {
    "/path/to/project": {
      "command": "npm run dev",
      "port": 5173,
      "root": "/path/to/project",
      "readyPattern": "ready in",
      "readyTimeoutMs": 30000
    }
  }
}
```

按 `cwd` 匹配：`cwd` 等于某项或位于其下（取最长匹配）。没有条目也能用：面板仍可连接你自己起的 dev server（只要上游在回环上）。

### invariant（预览侧）

1. 只代理**回环上游**：非回环主机名 / 端口与配置不符 → 地址栏直接**拒绝并说明原因**（不静默失败）。
2. 上游端口未知（dev server 未起、未配置）时，`/__proxy/` 返回 502 + 事实，**不猜端口**、不回退到别的地址。
3. `/__file/` 只能读配置 `root` 内的文件（`realpath` 包含判定）。
4. `stop` 只杀**自己 spawn 的进程组**（`detached: true` + `kill(-pid)`），不碰用户已有进程。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 7799 | 监听端口（仅回环） |
| `--host` | 127.0.0.1 | **仅允许回环**，非回环直接拒绝启动（远程请用 `ssh -L` 隧道） |
| `--cwd` | 当前目录 | pi 子进程的工作目录 |
| `--model` | pi 默认 | 传给 `pi --model`（未指定时用 pi 默认；本机默认 `zai-api/glm-5.3` 可能余额不足，会如实显示 429） |
| `--thinking` | pi 默认 | 传给 `pi --thinking` |

## invariant（代码强制）

1. **只绑回环**：非回环 host 拒绝启动。
2. **审批不可绕过**：只有 `select`/`confirm`/`input`/`editor` 是对话框；未响应的审批保持挂起，
   弹窗带 `timeout` 时到期只上报 `cancelled`（pi 侧收到 `undefined` = 未批准），**绝不自动放行**。
3. **不重放**：子进程崩溃只上报事实，未决对话不自动重放。
4. **单向记录不误判**：`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` 只在 UI 显示，不等待回答。
5. **不吞错**：模型错误（如 429）、重试、扩展错误、子进程 stderr 都原样送到界面。

## 主题

**只使用浅色（白底）**：`web/index.html` 声明 `<meta name="color-scheme" content="light">`，
`main.ts` 固定 `<html class="light">` 并设 `colorScheme = "light"`，样式表里**没有任何
`prefers-color-scheme` 分支**——所以系统深色模式下界面依然是白底（本机 Dark 模式下实测）。
界面上没有深色开关。

## 验收

桌面版重装步骤（app 必须先关掉）见 `MAINTENANCE.md`。

`npm run typecheck` 用 **vue-tsc**（模板也查类型）；离线探针 `probe/message-probe.ts` 覆盖消息块渲染。

八个探针，共 **108 项**（都需要服务在对应端口运行）：

| probe | 覆盖 | 结果 |
| --- | --- | --- |
| `preview-probe.ts`（:7801） | 代理拒绝/就绪判定/HTML·CSS 改写/脚本注入/CSP 事实/JS 透传/`/__file/` 只读与越界/停后进程组消失 | 17/17 |
| `control-probe.ts`（:7801） | 命令枚举与执行、模型/思考等级、设置往返、统计/树/fork/最后助手文本、`bash` 真执行 + 流式、未知命令与缺字段拒绝、配置白名单/校验/原子写 | 21/21 |
| `workspace-probe.ts`（:7799，需干净注册表） | 注册表增删、realpath 归一、**非 active 写操作被拒**、切换后读操作跟随、按 workspace 列会话、close 清理 | 9/9 |
| `files-probe.ts`（:7799） | 树列出/`.git` 不展开/ignored 标记/子目录按需、越界 403、`..` 403、软链出界 403、超大与二进制拒绝、目录选择器只列目录 | 13/13 |
| `git-probe.ts`（:7799，临时仓库） | 状态分类、diff/numstat、stage/commit/log、建分支、脏树切分支拒绝、未知分支拒绝、discard 需确认 + 快照 ref 真实存在、未跟踪不可丢、越界拒绝、冲突 `UU` 识别、无危险 argv | 19/19 |
| `disconnect-probe.ts`（:7801） | 审批弹窗出现后客户端断线：仍挂起、**不自动放行**、无副作用、重连的客户端仍能收到该弹窗、拒绝后命令确实没跑 | 7/7 |
| `health-probe.ts`（离线） | 健康指示映射：正常收敛成一句 `connected`；connecting / closed（带重试秒数）/ error / pi exited（带码）/ 无码退出 / stopped 各自命名；socket 问题优先于子进程问题；每个状态都有 tooltip | 9/9 |
| `markdown-probe.ts`（离线） | 标题/粗斜体/行内代码/围栏块/嵌套列表/引用/表格/链接渲染 + `<script>`、`<img onerror>`、`javascript:` 三种注入样本被中和 | 13/13 |

`node probe/preview-probe.ts`（需先按上面用法起服务）会真实起一个 dev server 并核对：无上游时拒绝、就绪判定、HTML/CSS 改写与脚本注入、CSP 放宽事实、JS 透传、`/__file/` 只读与越界拒绝、`stop` 后进程组确实消失。当前 **17/17 通过**。

## 工具调用卡片

展开一张工具卡会看到**输入（参数）与输出**，和终端里一致：输入来自 assistant 的 `toolCall.arguments`，输出来自随后的 `toolResult` 消息（或运行中的流式片段）。状态只如实反映观察到的结果：`done` / `error`，没有结果的调用（中断或被刷新打断）显示 `unknown`，不会假装还在运行。超长内容保留尾部 20000 字符并写明丢弃量。

## 目录与界面结构

- **目录是唯一的入口**：顶栏左侧那个按钮（显示当前目录，长路径中间省略、`…` 标明是省略）负责打开 / 切换 / 关闭目录与最近目录；侧栏只负责会话，不再重复一个 "Open folder…"。**没有任何目录时**界面进入空态（"No folder open"）并请你自己选一个 —— 首次启动不会替你挑目录。
- 目录记忆：`piwebui-workspaces.json` 里的 `active` 是"退出时开着的目录"，下次启动会打开它；想回到"让你自己选"就把这个文件移开。
- 窗口变窄可用：顶栏换行、抽屉改为覆盖层，`Settings` 之类标签不会被裁掉；会话名/路径/refs 一律省略号（悬停看全）
- 深链：`?dir=<目录>` 打开工作区、`?file=<路径>` 打开文件、`?drawer=files|git|shell|preview|settings`（可带 `?gitTab=` / `?settingsTab=`）直接打开某个抽屉
- 右侧抽屉：`Files` · `Git`（内含 `Changes` / `History` / `Branches` 分页）· `Shell`（**真终端**（shell 退出后重开抽屉即得到新 shell）：服务端 node-pty 里的长驻 shell + 前端 xterm.js，`cd`/`export`/颜色/`clear`/全屏程序都原生可用；输出**不进模型上下文**，需要时用 *Insert screen into prompt*）· `Preview` · `Settings`（二级标签 `Model` / `Credentials` / `Commands` / `Session` / `Config`）。会话列表在左侧栏，每条可以删除（两步确认）。

## 运行状态与错误显示

- 输入框的 `Send` / `Stop` 跟随真实运行状态（`agent_start` 置位、`agent_end` / `agent_settled` 复位，并用 `get_state.isStreaming` 对账）；**运行中发送会自动按 follow-up 排队**并提示，不会因为协议要求 `streamingBehavior` 而被拒。
- 错误条是**短暂**的：新活动（发消息 / 开始运行 / 成功响应）自动清除，也可以点 `Dismiss`；出错时若仍在运行，条上直接给 **Stop the run**。持续性问题（socket 断开、pi 退出）由顶栏健康指示表达，不混在错误条里。

## 已知限制

- 代理只转发 HTTP：**dev server 的 WebSocket / HMR 通道没有转发**（页面能用，热更新不生效）；需要热更新请直接用浏览器打开 dev server。
- 同一时刻只允许一个 dev server（我们只管理自己起的那一个）。
- 文件面板只读；git 面板不做 push / PR / 交互式 rebase；冲突只展示不解决。
- 代理只转发 HTTP（无 HMR）；同一时刻只允许一个 dev server。
- 同一 workspace 的**多标签页**都能发命令（"单写者"目前是 workspace 级，而不是标签页级）。
- 浏览器里的会话与终端 TUI 的会话**相互独立**（pi 没有"同一会话两处驱动"的机制）。
- 预览面板（P3）与元素拾取尚未实现；审批面板已实现但待端到端验收。

## 许可与署名

（历史）此前随组件库分发的字体 Fusion Pixel（SIL OFL 1.1）、
图标 Pixel Icon Library（CC BY 4.0）、pixelarticons（MIT）需保留署名。

# piwebui — 像素风本地 Web UI（Vue 3 + TS + Pinia + Pixelium）

在浏览器里跑一个 pi 会话：流式对话、工具卡片、扩展审批弹窗（policy 的四选一），
后续加浏览器预览面板（iframe + 元素拾取）。

## 架构

```
浏览器 (Vue 3 + Pinia + @pixelium/web-vue)
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
npm install                        # 依赖（含 @pixelium/web-vue）
npm run build                      # 前端 → dist/
node server/main.ts --port 7799 --cwd /path/to/project \
  --model deepseek/deepseek-flash --thinking low
# 浏览器打开 http://127.0.0.1:7799
```

开发探测（不经过浏览器，直接验证桥）：

```bash
node probe/ws-probe.ts "reply with exactly: pong" --seconds 90
```

## 可读性（字号）

Pixelium 的组件字号是**写死的 px**（12/14/15px），`setPixelSize` 只重算组件盒子尺寸、不改字号，所以在 `web/src/styles/app.css` 里对整页做了一次缩放：

```css
html { zoom: 1.3; }   /* 想更大/更小就改这一个数 */
```

整页统一缩放（文字、边框、抽屉、对话框一起变），代价是布局视口变窄（1280 物理像素 ≈ 984 CSS px）；代码块与长段落也加了 `pre-wrap` + `overflow-wrap: anywhere`，不会因为放大而被裁切。**注意**：加了 `zoom` 之后，系统的无障碍坐标空间是缩放前的，自动化点击要用元素索引而不是绝对像素。

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

**只使用浅色（白底）**：`web/index.html` 与启动脚本都把 `<html>` 固定为 `light`，
并声明 `<meta name="color-scheme" content="light">`。Pixelium 的 `:root.light`
选择器比它的 `prefers-color-scheme: dark` 媒体查询优先级更高，因此在系统深色模式下
界面同样是白底（已在本机 Dark 模式下实测）。深色开关已从界面移除。

## 验收

`node probe/preview-probe.ts`（需先按上面用法起服务）会真实起一个 dev server 并核对：无上游时拒绝、就绪判定、HTML/CSS 改写与脚本注入、CSP 放宽事实、JS 透传、`/__file/` 只读与越界拒绝、`stop` 后进程组确实消失。当前 **17/17 通过**。

## 已知限制

- 代理只转发 HTTP：**dev server 的 WebSocket / HMR 通道没有转发**（页面能用，热更新不生效）；需要热更新请直接用浏览器打开 dev server。
- 同一时刻只允许一个 dev server（我们只管理自己起的那一个）。
- "单写者"（多标签页同时驱动同一个 RPC 子进程）尚未按标签页隔离，当前所有标签页都能发命令。

- 前端依赖 `@pixelium/web-vue@0.2.1-delta`（预发布版本号）。
- 浏览器会话与 TUI 当前会话**相互独立**（pi 无"同一会话两处驱动"机制）。
- 预览面板（P3）与元素拾取尚未实现；审批面板已实现但待端到端验收。

## 许可与署名

Pixelium Design（MIT）随包分发；其内置字体 Fusion Pixel（SIL OFL 1.1）、
图标 Pixel Icon Library（CC BY 4.0）、pixelarticons（MIT）需保留署名。

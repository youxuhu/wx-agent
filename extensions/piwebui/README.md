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

## 会话列表与切换

`/api/sessions`（以及 WS 的 `list_sessions`）从磁盘读当前 cwd 的会话文件（pi 存于
`<agentDir>/sessions/<cwd 编码>/<时间戳>_<id>.jsonl`；编码为 `--` + 去掉前导 `/` 并把 `/`→`-` + `--`，
cwd 先做 realpath，故 `/tmp` 落到 `--private-tmp--`）。列表包含：名称（`session_name` 条目）、
首条用户提示、消息条数、大小、时间。

- **切换**：WS `{type:"switch_session", path}` → 子进程 `switch_session`；成功后自动
  `get_messages` + `get_state` + `list_sessions` 重新水合界面。
- **重命名**：WS `{type:"set_session_name", name}`（名称来自 `get_state.sessionName`）。
- **invariant**：只允许切换到**当前 cwd 会话目录内**的 `.jsonl`；其他路径一律拒绝并报事实。
- 界面：标题栏 `sessions` 按钮打开抽屉，行内显示 `current` / `switch`、时间、条数、大小与首句。

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

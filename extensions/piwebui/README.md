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

## 已知限制

- 前端依赖 `@pixelium/web-vue@0.2.1-delta`（预发布版本号）。
- 浏览器会话与 TUI 当前会话**相互独立**（pi 无"同一会话两处驱动"机制）。
- 预览面板（P3）与元素拾取尚未实现；审批面板已实现但待端到端验收。

## 许可与署名

Pixelium Design（MIT）随包分发；其内置字体 Fusion Pixel（SIL OFL 1.1）、
图标 Pixel Icon Library（CC BY 4.0）、pixelarticons（MIT）需保留署名。

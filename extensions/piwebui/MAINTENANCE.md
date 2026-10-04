# piwebui 维护手册（Maintenance Manual）

> 面向"以后要改它的人"（大概率是未来的我或你）。README 讲**怎么用**，本文讲**怎么改、怎么验、坏了怎么查**。
> 变更历史见仓库根的 `AGENTS.md`；方案与分期的文档在 `~/project/minepi/docs/`。

---

## 1. 它是什么

**一个本地 Web 服务 + 一个浏览器 UI，把 pi 当子进程驱动。** 不是 pi 的替代品，是 pi 的另一个前端：
TUI 能干的事这里都能干（有差距清单），另外多了预览面板、文件树、Git 面板、workspace 切换。

```
浏览器 (Vue3 + Pinia, 无组件库)
   │  HTTP + 单个 WebSocket（只走回环）
   ▼
server/main.ts ── 只绑 127.0.0.1 ──┬── Workspace 注册表（一个目录一个 pi 子进程）
   │                               │      └── PiRpcChild: spawn `pi --mode rpc`，JSONL 双向
   │                               ├── 静态 UI（dist/）+ /api/*
   │                               ├── 审批（extension_ui_request → 浏览器对话框 → extension_ui_response）
   │                               ├── /api/tree /api/file（只读文件）
   │                               ├── /api/git/*（git CLI 封装）
   │                               └── /__proxy/ /__file/（预览代理 + 只读文件渲染）
   ▼
可选：Tauri 壳（desktop/）—— 打包成 macOS app，内嵌 Node + 精简 pi 运行时
```

**三条主线**：命令面走 RPC（`RPC_PASSTHROUGH` 白名单）；事件面走广播（所有记录都带 `workspace`）；文件/Git 面走 HTTP（前端不能传 argv）。

---

## 2. 文件地图

| 路径 | 作用 |
| --- | --- |
| `server/main.ts` | HTTP 路由 + WS 消息分发 + workspace 注册表 + 配置读写。**所有 invariant 的落点** |
| `server/rpc.ts` | `PiRpcChild`：spawn pi、严格 LF 分帧、背压、崩溃只上报不重放。支持 `piNode+piScript`（打包场景） |
| `server/workspace.ts` | 一个目录 = 一个 pi 子进程 + 待决审批 + 预览 dev server + 仓库探测 |
| `server/sessions.ts` | 读磁盘会话列表（`<agentDir>/sessions/<cwd 编码>/`，**cwd 先 realpath**） |
| `server/fs.ts` | 目录浏览（`$HOME`+`/tmp` 两个根）、`/api/tree`、`/api/file`（realpath 包含 + 2MB/二进制拒绝） |
| `server/git.ts` | git CLI 封装：status/diff/numstat/log/show/branches + stage/unstage/discard/commit/checkout/branch |
| `server/auth.ts` | 凭据：只读列出 provider 与类型（**永不回传密钥值**），写入 API key / 删除凭据（原子写 + `.bak` + 0600） |
| `server/preview.ts` | 同源代理（HTML/CSS 改写 + 拾取脚本注入 + 剥 CSP 并标注）、`__file` 只读、`DevServer`（只杀自己的进程组） |
| `web/src/stores/session.ts` | 唯一的 store：WS 连接与重连、全部状态与动作 |
| `web/src/components/*.vue` | 壳（App）、对话流、工具卡、审批、状态栏、左侧栏、右侧抽屉各面板 |
| `web/src/markdown.ts` | 自研 markdown 渲染（先整段转义，只输出自己的标签） |
| `web/src/health.ts` | 顶栏健康指示（socket + pi 子进程合成一句） |
| `probe/*.ts` | 8 个可执行验收探针（见 §5），**改完必须跑** |
| `desktop/` | Tauri 壳（Rust）+ 打包资源（不进 git） |
| `scripts/desktop-prepare.mjs` | 组装桌面资源：打包 server → 复制 web → 裁剪 pi 运行时 → 下载 Node |
| `scripts/desktop-verify.mjs` | 打包前验证：用裁剪运行时起 pi 并确认**扩展能加载** |

---

## 3. 不变的约束（改代码前先读）

1. **只绑回环**：非 loopback host 直接拒绝启动（远程用 `ssh -L`）。
2. **审批不可绕过**：未响应/断线/超时 = 挂起或取消，**绝不自动放行、绝不自动重放**；只有 `select/confirm/input/editor` 是对话框。
3. **单写者**：一个 workspace 同时只有一个"active"能接写命令；其余只读观察。
4. **前端不能传 argv**：RPC 走 `RPC_PASSTHROUGH` 白名单（含必填字段校验），git 参数在服务端拼，路径先 realpath 包含。
5. **破坏性 git 操作先确认 + 先快照**（`refs/piwebui/<ts>`，并把 ref 作为事实回传）；未跟踪文件不可丢弃。
6. **不静默降级**：失败/拒绝/超时都原文回传；模型错误、重试、子进程 stderr 原样送到界面。
7. **只浅色**（`color-scheme: light`，样式表里没有深色分支）。

---

## 4. 开发循环

```bash
cd ~/.pi/agent/extensions/piwebui

npm run build            # 改前端后：vite 构建到 dist/
npm run typecheck        # vue-tsc：TS **加上 .vue 模板**的类型检查（build 不做检查）
npm run start -- --port 7799 --cwd <目录> --model <provider/model> --thinking low
                         # 或直接：node server/main.ts --port 7799 --cwd ~/project/minepi

# 桌面版
npm run desktop:prepare  # 组装 desktop/resources（下载 Node 49.9MB，首次较慢）
npm run desktop:verify   # 打包前自检：裁剪运行时能否起 pi + 扩展能否加载
npm run desktop:dev      # tauri dev（需要 ~/.cargo/bin 在 PATH）
npm run desktop:build    # 出 .app + .dmg
```

**改动后的最小验证顺序**：`npm run build` → `npm run typecheck` → 起服务 → 相关探针 → 浏览器实看。

---

## 5. 验收探针（8 个，共 108 项）

| 探针 | 需要 | 覆盖 | 期望 |
| --- | --- | --- | --- |
| `probe/preview-probe.ts` | :7801 | 代理拒绝/就绪判定/HTML·CSS 改写/注入/CSP 事实/JS 透传/`__file` 越界/停后进程组消失 | 17/17 |
| `probe/control-probe.ts` | :7801 | 命令枚举与执行、模型/思考等级、设置往返、统计/树/fork、`bash` 真执行+流式、未知命令与缺字段拒绝、配置白名单/校验/原子写 | 21/21 |
| `probe/workspace-probe.ts` | :7799 **且注册表干净** | 注册表增删、realpath 归一、非 active 写被拒、切换后读跟随、按 workspace 列会话、close 清理 | 9/9 |
| `probe/files-probe.ts` | :7799 | 树列出/`.git` 不展开/ignored 标记/子目录按需、越界 403、`..` 403、软链出界 403、超大与二进制拒绝、目录选择器只列目录 | 13/13 |
| `probe/git-probe.ts` | :7799（自建临时仓库） | 状态分类、diff/numstat、stage/commit/log、建分支、脏树切分支拒绝、未知分支拒绝、discard 需确认+快照 ref 真实存在、未跟踪不可丢、越界拒绝、冲突 `UU`、无危险 argv（静态扫源码） | 19/19 |
| `probe/disconnect-probe.ts` | :7801 + 测试 agentDir | 审批断线：仍挂起、不自动放行、无副作用、重连仍收到、拒绝后没执行 | 7/7 |
| `probe/markdown-probe.ts` | 无（离线） | 渲染各构件 + `<script>`/`<img onerror>`/`javascript:` 三种注入被中和 | 13/13 |
| `probe/health-probe.ts` | 无（离线） | 健康指示 9 种状态映射与优先级 | 9/9 |
| `probe/path-probe.ts` | 无（离线） | 顶栏路径显示：短路径原样、长路径保留根与末两段并带 `…`、空目录返回空串（由调用方给提示） | 8/8 |
| `probe/no-workspace-probe.ts` | 无（自己起服务，端口 0） | 首启语义：没有 `--cwd` 时**不自动开目录**（`active=null`）、`/api/sessions` 409、prompt 被明确拒绝、开目录后成为 active、重启记住上次选的目录 | 7/7 |
| `probe/message-probe.ts` | 无（离线，含真实 `get_messages` 抓包） | 消息块解析：判别字段是 **`kind`**（不是 `type`）、thinking 独立块、toolCall→toolCallId、字符串 content、空 content 不造假块、未知块类型被丢弃、`messageToText` 只取 text | 10/10 |
| `probe/run-lifecycle-probe.ts` | :7799 | 运行生命周期：运行中 plain prompt 会被 pi 拒绝（所以我们必须带 `streamingBehavior`）、`followUp` 被接受（`disposition: queued`）、settle 后 plain prompt 又能用、`get_state.isStreaming` 是布尔 | 6/6 |
| `probe/auth-probe.ts` | :7802 + 一次性 agentDir | provider 列表、**响应里不出现任何密钥值**（与真实 auth.json 比对）、OAuth 不可被 api key 覆盖、坏 provider/空 key 拒绝、写入合并、删除需确认、文件权限 600 | 11/11 |

跑法：`node probe/<name>-probe.ts`（部分支持 `BASE=` / `WS_A=` / `REPO=` 环境变量覆盖）。
**注意**：`workspace-probe` 假设服务是刚起的（注册表里只有一个 workspace）；重跑前请重启服务。

---

## 6. 怎么加东西（步骤）

**加一个 RPC 命令**：`server/main.ts` 的 `RPC_PASSTHROUGH` 表里加一行（`fields`/`required`/`write`）→ store 加动作与 `handleResponse` 分支 → UI 调用点。**表外一律拒绝**，别绕过。

**加一个右侧面板**：`web/src/components/` 新建组件 → `App.vue` 的 `TABS` 加一项与 `v-if` 分支 → 样式写进 `styles/app.css` 的设计令牌范围。

**加一个 HTTP 端点**：`server/main.ts` 里加路由 → **先取数据再 writeHead**（历史 bug：先写头再 await，一次抛错就把服务打崩）→ 路径必须 realpath 包含校验。

**加一个扩展/预设**：那是 pi 侧的事，见各扩展自己的 README；这里只负责显示（`get_commands` 会自动列出）。

**改 pi 版本 / 升级依赖后**：重跑全部 8 个探针 + 浏览器实看一遍；RPC 字段名以 `docs/rpc-commands.md` 为准（本仓库的 RPC 表就是照它逐条列的）。

---

## 6.5 长内容显示与布局（两个反复踩的坑）

1. **`.pane` 必须 `flex: 0 0 auto`**：抽屉主体是「可滚动的 flex 列」，若面板允许收缩（`min-height: 0`），它会被压扁、内容被裁——表现就是"某一段显示不完全"。改样式时别把它改回可收缩。
2. **长输出要给事实，不要静默截断**：shell 输出保留最近 200k 字符并显示"earlier N chars dropped"、pi 自己截断时显示 `pi truncated its response` + full log 路径；stats/tree/last assistant text 一律显示字符数 + Copy 按钮。新增长文本展示时照这个模式来。

## 6.6 运行状态与错误条（血泪教训）

- **`running` 必须由 `agent_end` / `agent_settled` 置回 false**，并且 `get_state.isStreaming` 要用来对账。曾经只在 `agent_start` 置 true → 首次运行后永久"运行中" → 之后每条消息都被 pi 以"streaming 必须指定 streamingBehavior"拒绝，看起来就是"出错后无法再正常回答"。
- **运行中发消息必须带 `streamingBehavior`**：客户端在 `running` 时自动用 `followUp` 排队（并提示用户），不要发裸 `prompt`。
- **错误条是短暂的**：新活动（发消息/开始运行/成功响应）会自动清掉，也可以点 `Dismiss`；真正的持续性问题（socket 断、pi 退出）由顶栏健康指示负责，不要塞进错误条。
- 运行卡住时的恢复手段：`abort`（会顺带清错并重新拉 `get_state`）。

## 6.7 消息渲染（"只看到 You/pi，没有内容"）

- 块的判别字段是 **`kind`**（`types.ts` 里的 `Block` 联合类型：`text` / `thinking` / `tool`），**不是 `type`**；工具块用 `toolCallId`。模板里写错字段名时，每个块都匹配不上，界面就只剩角色标签。
- 为什么没被拦住：`tsc --noEmit` **不检查 `.vue` 模板**。现在 `npm run typecheck` 走 **vue-tsc**，模板里的类型错误会直接报出来（这条就是它抓到的第二处：`ToolCard` 用了不存在的 `run.name`，真实字段是 `toolName`）。
- 改动消息渲染后跑 `probe/message-probe.ts`（用真实抓包做输入）。

## 6.8 没有目录也是一种合法状态

- `--cwd` 是**可选**的。不传时：先看 `piwebui-workspaces.json` 里记的 `active`（上次退出时开着的目录）并打开它；**没有记录就什么都不开**，界面给出 "No folder open" 并让用户选（首启绝不替用户挑目录——不能默认 `process.cwd()`，macOS 上那是 `/`）。
- 依赖目录的客户端水合（`get_state` / `list_sessions` / `preview_status` / `get_session_stats` / `get_messages` / `get_commands`）只在**有目录时**发一次，按目录去重；**断线重连必须重置这个去重标记**，否则重连后不再水合。
- 服务端对"没有目录"的回答是明确的：WS 报 `no workspace is open yet`，`/api/sessions` 返回 409，绝不猜一个目录。

## 7. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 页面 `not found: / (the UI is not built yet)` | `dist/` 不存在或路径不对：先 `npm run build`；桌面版看 `--web-dir` 是否指向 `Resources/dist` |
| 顶栏 `service closed` / `connecting…` | 服务没起或被 kill；浏览器会 1/2/4/8/15s 退避重连（**不重放任何消息**） |
| 顶栏 `pi exited (1)` | pi 子进程崩了：看服务日志 stderr 原文；常见是模型/凭据问题 |
| 首次启动就进了某个目录（比如家目录） | 说明 `piwebui-workspaces.json` 里记着上次的目录；把该文件移开即回到"让你自己选"的行为 |
| 消息只剩 `You` / `pi` 没有内容 | 块字段名写错（应为 `kind`）；`npm run typecheck`（vue-tsc）会报，`probe/message-probe.ts` 覆盖 |
| 出错后再也发不出消息 / 输入框一直显示 Stop | 运行标志没复位：见 §6.6；先按 `Stop`（abort）恢复，再确认 `agent_end`/`agent_settled` 的置位逻辑没被改坏 |
| 审批弹窗不出现 | 只有 `select/confirm/input/editor` 是对话框；`policy` 处于 `auto` 模式时 ask 规则会被自动放行（有审计）；`/policy mode normal` 可恢复 |
| 会话列表是空的 | 会话按 **cwd 的 realpath** 编码存放（`/tmp` → `--private-tmp--`）；切到正确的 workspace 再看 |
| `git` 面板显示"not a git repository" | 当前 workspace 不是仓库（例如 `/tmp`） |
| 预览面板 502 `no local dev server upstream` | 没起 dev server 或 `preview.json` 没配端口；**不会猜端口** |
| 预览里样式/脚本 404 | 上游页面用了非根相对路径；代理只改写 `src/href/action/poster` 与 `url(/…)` |
| 切 workspace 后写命令被拒 | 单写者：只有 active 能写，先 `switch_workspace`（前端点 `Open folder` 里的 Switch） |
| 桌面版白屏 / 只有 splash | 看 app 的 stdout：`[service] …` 有没有 ready 行；`desktop:verify` 能复现大部分资源问题 |
| 桌面版报缺模块（如 `Cannot find module 'jiti'`） | 裁剪运行时少了依赖：往 `scripts/desktop-prepare.mjs` 的 `PI_RUNTIME_DEPS` 里加，然后 `desktop:prepare` + `desktop:verify` |
| 桌面版报 `Cannot find package 'ws'` | `tauri.conf.json` 的 `bundle.resources` 漏了 `../resources/node_modules`（`ws` 是 external，必须随包带） |
| 桌面版窗口停在 splash | 服务没起来：从终端跑 `"/Applications/pi agent.app/Contents/MacOS/pi-agent"` 看 stdout；失败信息现在也会显示在窗口里 |
| `--port 0` 时不知道端口 | 服务会打印机器可读就绪行 `{"type":"piwebui-ready","port":N}`；脚本/壳从 stdout 解析 |

**日志位置**：服务 stdout（浏览器版）/ `/tmp/pi-agent.log`（桌面版直接运行时）；探索类问题优先看服务日志而不是 UI。

---

## 8. 配置与数据文件

| 文件 | 内容 |
| --- | --- |
| `<agentDir>/piwebui-workspaces.json` | 最近打开的 workspace（桌面版/浏览器版共用） |
| `<agentDir>/preview.json` | 每个项目的 dev 命令/端口/root/就绪正则 |
| `<agentDir>/sessions/<cwd 编码>/*.jsonl` | pi 会话（我们只读列表、切换、重命名） |
| `<agentDir>/{settings,models,policy,sandbox,notify,computer-use,checkpoints,trust}.json` | 设置面板里可读写的白名单（**`auth.json` 永不暴露**） |
| `<agentDir>/auth.json` | provider 凭据（**可写不可读**：界面只能设置/删除，看不到值；写入 0600 + `.bak`） |
| `localStorage: piwebui.drawerWidth` | 右侧抽屉宽度 |

`agentDir` 解析顺序：`--agent-dir` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`。

---

## 9. 桌面版（Tauri）

**构成**：`Tauri(Rust) → spawn <Resources>/node <Resources>/server.mjs --port 0 --web-dir <Resources>/dist --pi-node <node> --pi-script <pi/dist/bundle/cli.js>`；端口从就绪行读回；关窗时 kill 子进程（服务自己的 `shutdown()` 再收掉所有 pi 与 dev server）。

| 项 | 实测值 |
| --- | --- |
| `.app` | **162.9 MiB**（其中 Node 二进制 112MB、pi 运行时 76MB、web 156KB、server.mjs 200KB） |
| `.dmg` | **48.2 MiB** |
| 首次构建 | 装 Rust（`rustup`，本机原先没有）+ crates 下载 + 编译 ≈ 数分钟 |

**为什么 pi 运行时只要 76MB**：`dist/`（20MB，含预打包 chunks）+ `jiti`（扩展靠它加载）+ `typebox` + `@earendil-works/*` + `photon`/`quickjs-wasi`。**验证方式是 `desktop:verify`**，不是"能编译就算过"。

**坑（都踩过）**：
- `ws` 是 CJS，ESM 打包会炸动态 require → esbuild `--external:ws` + 随包带 `node_modules/ws`。
- 打包后 `server.mjs` 在 `Resources/` 根，默认的"同级 dist"找不到 UI → 壳传 `--web-dir`。
- 资源复制不保证可执行位 → Rust 侧 spawn 前 `chmod 755 node`。
- 未签名 → 首次打开需右键 → 打开；ATS 需要本地例外（`bundle.macOS.exceptionDomain`）。
- 直接 `nohup app &` 会被上层 shell 结束时杀掉（表现为窗口一闪、日志出现 `[shell] stopping the service`）——那是**进程组**被收，不是 app 的 bug。

---

## 10. 发布与版本管理

- 代码在 `~/.pi/agent`（=`youxuhu/pi-config` 仓库）。每次改动：`git add -A && git commit && git push`。
- 文档/方案在 `~/project/minepi`（本地仓库，无 remote）：`docs/pi-plugins-status.md`（插件总表）、`docs/*-plan.md`（方案）、`AGENTS.md`（变更记忆）。
- **每个构建完成必须**：1) 追加 AGENTS.md 一行目的 + 一行做法；2) 若踩坑绕过，记一条短 bullet；3) 跑相关探针；4) 更新 README/本手册中受影响的段落。
- 桌面版产物不进 git（`desktop/resources`、`desktop/src-tauri/target` 应保持未跟踪）。

---

## 11. 安全审计清单（改动前后各过一遍）

- [ ] 仍然只绑回环？没有新增对外监听/转发。
- [ ] 新增的 RPC 命令在 `RPC_PASSTHROUGH` 表里？必填字段校验在服务端？
- [ ] 新增的文件路径都做 realpath 包含校验？`..`/软链越界会被拒？
- [ ] 破坏性操作（删文件、丢弃改动、切分支、杀进程）都有确认 + 快照/可回退，且**只碰自己 created 的东西**？
- [ ] 失败路径是"报事实"而不是"重试/假装成功"？
- [ ] UI 里渲染的任何外部文本都转义（markdown 渲染器：转义优先、链接协议白名单、不自动拉外部资源）？
- [ ] 凭据类文件（`auth.json` 等）没有被读/写/展示？

/**
 * ui.ts — result rendering + image pipeline helpers (PLAN v2 §3.3 + v3.1 §1/§4).
 * formatObservation() emits the tiered observation templates (full/tree/minimal, PLAN §1.3);
 * BRIEFING (§4.3, L1) and MANUAL (§4.4, L2) implement prompt progressive disclosure.
 */

import { treeSample, type Observation } from "./gate";
import type { WindowInfo } from "./platform";

const MAX_TREE_LINES = 197; // PLAN v2 §5.4 hard cap (200 lines incl. head/focus/blocked lines)
const MAX_TREE_NODES = 400;

/** L1 (PLAN §4.3): one-time briefing prepended to the first computer result of a task. */
export const BRIEFING = `── computer 操作手册（首次调用附赠，此后不再重复）──
观察分级: tree(默认,纯文本控件树,0图像成本) | full(截图+树,关键节点自动触发) | minimal
截图时机: 任务开始/焦点切换/页面跳转/blocked/每10动作心跳；其余时刻用控件树定位
坐标: element index 优先；pixel 仅兜底，须落在最近截图 raster 内
聚焦: action:"activate" + app 参数把目标 App 调到前台（防遮挡/防输入错窗）
停止: 连续3次无变化或 blocked 时必须换路径或向用户汇报，勿重复同一动作
权限: ask 模式每动作弹确认；/cua bypass 免确认
更多: action:"help"`;

/** L2 (PLAN §4.4): on-demand manual returned by action:"help". */
export const MANUAL = `[manual] computer — 桌面 GUI 自动化完整手册 (v3.1)

== 动作语义 ==
screenshot            显式截图；返回 full 观察（截图+控件树+窗口清单）
left_click            左键单击目标（element index 优先，x/y 兜底）
double_click          左键双击
right_click           右键单击
type   + text         逐字符键入文本（换行=Return；中文走兜底通道）
key    + text         组合键，如 "cmd+c" / "enter" / "tab"
scroll + up|down      滚轮滚动，amount 默认 3
wait   + ms           等待 100..10000 毫秒（不产生观察）
list_windows          仅窗口清单（不截图）
activate + app        把目标 App（名称或 bundleId）调到前台；返回 full 观察
help                  返回本手册

== 观察分级 (§1) ==
full    = 截图 + 控件树 + 窗口清单。自动触发：任务首个观察 / activate / 焦点切换 /
          控件树指纹变化>30%（页面跳转）/ blocked 命中 / 每 10 个动作心跳。
tree    = 控件树 + 窗口清单，纯文本 0 图像 token（默认）。
minimal = 一行状态回执（hash + 焦点窗口），用于 3 秒内重复的 (action,target)。

== 定位优先级 (v3.2) ==
1. elementName:按控件名匹配（精确>前缀>包含，可点优先）——首选，免索引免坐标；
   例: left_click elementName:"播放" / elementName:"搜索"
2. element index:树里的编号（elementName 找不到或同名多个时用）
3. x/y 像素:最后手段，只能用于最近截图 raster 系
自动置顶:动作前若焦点漂移到别的 App，扩展会自动把上次观察的 App 调回前台（防遮挡/防点错窗）。

== 播放器/网页应用技巧 ==
视频/音频站点的播放器控件几乎总在 a11y 树里：先 list 一次树，找 Button "播放/暂停"、
时间戳 StaticText（如 "01:16 / 03:48"）、倍速/全屏等，直接 element index 点击，无需截图猜坐标。
验证是否在播：两次观察比对时间戳文本或 stateHash 是否推进；wait 动作 0 成本。

== 坐标系 (§3) ==
full 观察的截图坐标 = raster 系（图片实际像素）；tree 观察的控件坐标 = logical 系
（屏幕点）。element index 自动对应正确坐标系；手写 x/y 时只能用于 raster（最近截图）。
widget index 为深度优先 1-based；tree 上限 400 节点 / 200 行。

== 窗口与焦点 ==
焦点判定以前台应用 pid 为准（frontmostApplication 交叉核验）。
被遮挡时先 activate 目标 App 再点击，避免动作进错窗口。

== 阻塞与停止 ==
结果尾行 blocked: popup|focus-change|no-progress 给出原因与建议。
连续 3 次无变化或重复循环会被控制器硬停，此时必须换路径或向用户汇报。

== /cua 命令 ==
/cua status   能力矩阵 + 模式 + 动作计数
/cua ask      每个变更动作弹确认（默认）
/cua bypass   免确认（信任环境）
/cua clear    清空 alwaysAllowed 并回到 ask
/cua doctor   授权（辅助功能/屏幕录制）与后端自检

== 权限 ==
配置持久化于 ~/.pi/agent/computer-use.json；动作可 "Always allow" 进白名单。`;

/** Renders the widget tree in the PLAN §1.3 `widgets` block format (logical space). */
export function renderWidgetTree(obs: Observation): string {
	const root = obs.widgetTree;
	if (!root) return "";
	const { count } = treeSample(root);
	const lines: string[] = [
		obs.coordSpace === "logical"
			? "widgets (logical 系):"
			: "widgets (raster 系):",
	];
	const walk = (n: Observation["widgetTree"] & object, depth: number): boolean => {
		if (lines.length > MAX_TREE_LINES) return false;
		const node = n as NonNullable<Observation["widgetTree"]>;
		const pad = " ".repeat(depth + 1);
		const label = node.label.length > 80 ? `${node.label.slice(0, 80)}…` : node.label;
		const value = node.value ? ` "${node.value}"` : "";
		const focused = node.focused ? " [focused]" : "";
		lines.push(
			`${pad}${node.index} ${node.role} "${label}"${value} center(${node.center.x},${node.center.y})${focused}`,
		);
		for (const c of node.children) if (!walk(c, depth + 1)) return false;
		return true;
	};
	walk(root, 0);
	if (lines.length >= MAX_TREE_LINES) lines.push("(树超过行数上限，已截断)");
	return lines.join("\n");
}

function formatFocused(windows: WindowInfo[]): string {
	const f = windows.find((w) => w.isFocused);
	if (!f) return "none";
	return `${f.appName} — ${f.title || "(no title)"}`;
}

/**
 * formatObservation — tiered templates (PLAN v3.1 §1.3):
 *
 * tree:    [computer] <action> <target> → ok (round N/max) | obs: tree
 *          focus: App | hash: xxxxxxxx(tree)
 *          widgets (logical 系): ...
 *          共 N 节点，截图省略（action:"screenshot" 可随时获取）
 * full:    same head with obs: full + raster state line + widgets + screenshot attached
 * minimal: one-line status receipt (hash + focused window)
 */
export function formatObservation(opts: {
	action: string;
	target: string;
	ok: boolean;
	round: number;
	maxRounds: number;
	obs: Observation;
}): string {
	const { action, target, ok, round, maxRounds, obs } = opts;
	const head = `[computer] ${action} ${target} → ${ok ? "ok" : "failed"} (round ${round}/${maxRounds}) | obs: ${obs.level}`;

	if (obs.level === "minimal") {
		const focusShort = obs.windows.find((w) => w.isFocused)?.appName ?? "none";
		return `${head}\nhash: ${obs.stateHash.slice(0, 8)} | focus: ${focusShort}`;
	}

	const focusApp = obs.frontApp?.appName ?? formatFocused(obs.windows).split(" — ")[0] ?? "none";
	const hashLabel = obs.level === "tree" ? `${obs.treeFingerprint ?? obs.stateHash.slice(0, 8)}(tree)` : obs.stateHash.slice(0, 16);
	const focusLine = `focus: ${focusApp} | hash: ${hashLabel}`;
	const widgets = renderWidgetTree(obs);
	const blocked = obs.blocked
		? `blocked: ${obs.blocked.kind} — ${obs.blocked.detail}. hint: ${obs.blocked.hint}`
		: "blocked: none";
	const parts = [head, focusLine];
	if (widgets) parts.push(widgets);
	if (obs.level === "tree") {
		parts.push(`共 ${obs.treeNodeCount ?? 0} 节点，截图省略（action:"screenshot" 可随时获取）`);
	} else {
		if (obs.screenshot) parts.push(`screenshot: ${obs.screenshot.width}x${obs.screenshot.height} raster 系（x/y 参数以此为权威）`);
		parts.push(`windows: ${obs.windows.map((w) => `${w.appName}${w.isFocused ? "*" : ""}`).join(", ") || "none"}`);
	}
	parts.push(blocked);
	return parts.join("\n");
}

/** Plain text notice block (parameter errors, platform-unsupported, gate denials). */
export function formatNotice(text: string): string {
	return `[computer] ${text}`;
}

/**
 * llm-speed — output tok/s in the footer stats line.
 *
 * The stats line (`↑in ↓out R… CH… $… x%/1.0M`) is part of the BUILT-IN footer,
 * and setStatus can only reach its third line (extension statuses). So this
 * extension replaces the footer via ctx.ui.setFooter() and faithfully mirrors
 * the three built-in lines (see dist/modes/interactive/components/footer.js),
 * inserting a colored speed segment into line 2.
 *
 * Speed: output tokens / generation time. message_start records t0; the FIRST
 * message_update re-records t0 (excluding time-to-first-token); message_end
 * computes usage.output / elapsed. One value per LLM response, latest wins.
 * Sanity guard: burst-delivered streams (proxy/gateway buffering) collapse the
 * wall clock, so a response is only trusted with >=3 streamed chunks and >=0.5s
 * elapsed; otherwise the footer shows "t/s ?" instead of a garbage number.
 *
 * Bands: <100 error(红) · 100–200 dim(灰) · 200–300 accent(蓝) · ≥300 success(绿).
 *
 * Approximations vs built-in footer (data not accessible from extensions):
 *   - "(auto)" compact marker shown unconditionally (auto-compact is default-on)
 *   - "xp" experimental badge omitted
 *   - "(sub)" only approximated for provider === "kimi-coding"
 *
 * Commands: /speed (show latest) · /speed on | off (mount custom / restore built-in).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const NOTIFY_MAX_LINES = 4;

type Theme = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>[1];

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function fmtCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home || !cwd.startsWith(home)) return cwd;
	const rel = cwd.slice(home.length);
	return rel === "" ? "~" : `~${rel}`;
}

function speedColor(speed: number, theme: Theme): string {
	const label = `${Math.round(speed)} t/s`;
	if (speed < 100) return theme.fg("error", label);
	if (speed < 200) return theme.fg("dim", label);
	if (speed < 300) return theme.fg("accent", label);
	return theme.fg("success", label);
}

export default function llmSpeed(pi: ExtensionAPI) {
	let t0: number | undefined;
	let latestSpeed: number | undefined;
	let speedUnknown = false;
	let chunkCount = 0;
	let requestRender: (() => void) | undefined;
	let enabled = true;
  let firstChunk = false;
  let watch = "?";
  let watchSequence = -1;
  let sessionId: string | undefined;
  let cachedStats: {input:number;output:number;cacheRead:number;cacheWrite:number;cost:number} | undefined;
  const invalidateStats = () => { cachedStats = undefined; requestRender?.(); };
  const resetStream = () => { t0 = undefined; firstChunk = false; chunkCount = 0; speedUnknown = false; };
  pi.events.on("pi-subagents:watchdog-state:v1", (event: any) => {
    if(event?.version !== 1 || event.sessionId !== sessionId || event.sequence <= watchSequence) return;
    watchSequence = event.sequence; watch = event.phase; requestRender?.();
  });
  for(const event of ["session_compact", "agent_settled"] as const) pi.on(event, invalidateStats);
  // Branch/session switch: stream state belongs to the old branch — reset it too.
  pi.on("session_tree", () => { resetStream(); invalidateStats(); });


	const computeSpeed = (ctx: ExtensionContext, usage: UsageLike): void => {
		if (ctx.mode !== "tui") return;
		if (t0 === undefined || usage.output <= 0) return;
		const elapsedSec = (performance.now() - t0) / 1000;
		const chunks = chunkCount;
		t0 = undefined;
		chunkCount = 0;
		if (elapsedSec <= 0) return;
		// Unreliable measurement (burst delivery, single-shot response): show "?"
		// instead of an absurd number, and never fake it with the previous value.
		if (chunks < 3 || elapsedSec < 0.5) { latestSpeed = undefined; speedUnknown = true; requestRender?.(); return; }
		speedUnknown = false;
		latestSpeed = usage.output / elapsedSec;
		requestRender?.();
	};

	const buildStatsLine = (ctx: ExtensionContext, theme: Theme, footerData: unknown, width: number): string => {
		// Cumulative usage across ALL session entries (mirrors built-in footer).
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		if (!cachedStats) for (const entry of ctx.sessionManager.getEntries() as Array<Record<string, any>>) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const u = entry.message.usage as UsageLike | undefined;
				if (!u) continue;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
			} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
				const u = entry.message.usage as UsageLike;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				const u = entry.usage as UsageLike;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost.total;
			}
		}

    if(cachedStats) ({input,output,cacheRead,cacheWrite,cost}=cachedStats);
    else cachedStats={input,output,cacheRead,cacheWrite,cost};

		// Context usage (compaction-aware).
		const contextUsage = ctx.getContextUsage() as { percent: number | null; contextWindow?: number } | undefined;
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";

		const parts: string[] = [];
    const cfg = pi.getSettings().compaction;
    const key = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const reserve = cfg?.modelOverrides?.[key]?.reserveTokens ?? cfg?.reserveTokens ?? 16384;
    const threshold = contextWindow ? `${((contextWindow-reserve)/contextWindow*100).toFixed(0)}%` : "?";
    parts.push(`ctx ${contextPercent}%`, `watch ${watch}`, `compact ${cfg?.enabled===false?"off":threshold}`);
    // Session-cumulative cache hit rate, one decimal (99.2%, never rounded to 100%).
    // No cached prompt tokens at all -> "?"; nothing reported by the provider -> omit.
    const promptTotal = input + cacheRead + cacheWrite;
    if (promptTotal > 0) {
      parts.push(`cache ${cacheRead + cacheWrite > 0 ? ((cacheRead / promptTotal) * 100).toFixed(1) + "%" : "?"}`);
    }
    while(parts.length>2 && visibleWidth(parts.join("  ·  "))>width) parts.pop();
    let statsLeft = truncateToWidth(parts.join("  ·  "),width,"…");
    let statsLeftWidth = visibleWidth(statsLeft);

		// Right side: model id + thinking level + provider prefix (if room).
		const modelName = ctx.model?.id || "no-model";
		let rightSide = modelName;
		if (ctx.model?.reasoning) {
			const level = ctx.thinkingLevel || "off";
			rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
		}
		const fd = footerData as { getAvailableProviderCount?: () => number } | undefined;
		if (ctx.model && typeof fd?.getAvailableProviderCount === "function" && fd.getAvailableProviderCount() > 1) {
			const withProvider = `(${ctx.model.provider}) ${rightSide}`;
			if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
		}
		const rightSideWidth = visibleWidth(rightSide);
		if (statsLeftWidth + 2 + rightSideWidth <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLeft = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - 2;
			if (availableForRight >= rightSideWidth) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
				statsLeft = statsLeft + padding + truncatedRight;
			}
		}
		return statsLeft;
	};

	const mountFooter = (ctx: ExtensionContext): void => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: () => {
					unsub();
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					try {
						// Line 1: pwd (branch) • session name
						let pwd = fmtCwd(ctx.sessionManager.getCwd());
						const branch = footerData.getGitBranch();
						// Git branch and dirty counts remain together in the extension status row.
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) pwd = `${pwd} • ${sessionName}`;
						const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

						// Line 2: stats + speed, model right-aligned. Same dim treatment as
						// built-in: dim left part and remainder separately (inner ANSI resets).
						const statsLine = buildStatsLine(ctx, theme, footerData, width);
						const statsLeftWidth = Math.min(visibleWidth(statsLine), width);
						const line2 = theme.fg("dim", statsLine);

						// Line 3: extension statuses (plan / sandbox / git …), alphabetical.
						const lines = [pwdLine, line2];
            const telemetry = [latestSpeed!==undefined?speedColor(latestSpeed,theme):(speedUnknown?theme.fg("dim","t/s ?"):""), cachedStats?.cost ? `$${cachedStats.cost.toFixed(3)}` : ""].filter(Boolean).join("  ·  ");
						const statuses = footerData.getExtensionStatuses();
						if (statuses.size > 0) {
							const statusLine = Array.from(statuses.entries())
								.sort(([a], [b]) => a.localeCompare(b))
								// Mirror built-in sanitize: only [\r\n\t]. Stripping other control chars
						// (e.g. \x1b) would shred ANSI escapes into literal “[38;2…m” text.
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
								.join(" ");
							lines.push(truncateToWidth([telemetry,statusLine].filter(Boolean).join("  ·  "), width, theme.fg("dim", "…")));
						}
            if(statuses.size===0 && telemetry) lines.push(truncateToWidth(telemetry,width,"…"));
						return lines;
					} catch {
						return [theme.fg("dim", "footer error (llm-speed)")];
					}
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId(); watch="?"; watchSequence=-1; cachedStats=undefined;
		resetStream();
    pi.events.emit("pi-subagents:watchdog-query:v1",{});
    if (ctx.mode === "tui" && enabled) mountFooter(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role === "assistant") { t0 = performance.now(); firstChunk = false; chunkCount = 0; }
	});

	pi.on("message_update", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role !== "assistant") return;
		// First streamed chunk: restart the clock to exclude time-to-first-token.
		if (!firstChunk) { t0 = performance.now(); firstChunk = true; }
		chunkCount++;
	});

	pi.on("message_end", async (event, ctx) => {
		invalidateStats();
    if (event.message.role !== "assistant") return;
		const usage = (event.message as { usage?: UsageLike }).usage;
		if (!usage) return;
		computeSpeed(ctx, usage);
	});

	pi.registerCommand("speed", {
		description: "LLM output speed: /speed (latest) · /speed on|off (custom footer on/off)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				enabled = false;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored.", "info");
				return;
			}
			if (arg === "on") {
				enabled = true;
				if (ctx.mode === "tui") mountFooter(ctx);
				ctx.ui.notify("llm-speed footer mounted.", "info");
				return;
			}
			if (latestSpeed === undefined) {
				ctx.ui.notify("No LLM response measured yet.", "info");
				return;
			}
			const lines = [
				`Latest output speed: ${Math.round(latestSpeed)} tok/s`,
				`Bands: <100 red · 100-200 gray · 200-300 blue · ≥300 green`,
			];
			ctx.ui.notify(lines.slice(0, NOTIFY_MAX_LINES).join("\n"), "info");
		},
	});
}

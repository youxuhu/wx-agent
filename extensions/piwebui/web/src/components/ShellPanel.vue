<script setup lang="ts">
/**
 * The shell drawer: a real terminal (xterm.js) attached to a real PTY-backed shell that runs on the
 * service, inside the active workspace.
 *
 * This is not pi's `bash` command — that one is stateless (one shell per call), which is why `cd`
 * could never persist and `clear` could never work. Here the shell is a single long-lived process
 * with a terminal of its own, so `cd`, `export`, aliases, colors, `clear` and full-screen programs
 * behave the way they do in an editor's terminal. The trade-off is stated in the UI: what runs here
 * is not part of the model's context, so the terminal offers to insert its screen into a prompt.
 *
 * The session survives closing this drawer (the service keeps it, like an editor keeps a terminal),
 * so reopening replays the recent output instead of starting blank.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const host = ref<HTMLElement | null>(null);
const fit = new FitAddon();
let term: Terminal | null = null;
let observer: ResizeObserver | null = null;

/** Light palette: the whole UI is light-only, so the terminal follows it. */
const THEME = {
	background: "#ffffff",
	foreground: "#1c1c1c",
	cursor: "#1c1c1c",
	cursorAccent: "#ffffff",
	selectionBackground: "#d8e6ff",
	black: "#1c1c1c",
	red: "#c0392b",
	green: "#1a7f37",
	yellow: "#9a6700",
	blue: "#0b5cad",
	magenta: "#8250df",
	cyan: "#0e7490",
	white: "#f6f6f6",
	brightBlack: "#6b7280",
	brightRed: "#d1242f",
	brightGreen: "#1f883d",
	brightYellow: "#bf8700",
	brightBlue: "#218bff",
	brightMagenta: "#a475f9",
	brightCyan: "#3192aa",
	brightWhite: "#ffffff",
};

function fitNow(): void {
	if (!term || !host.value) return;
	try {
		fit.fit();
		store.resizePty(term.cols, term.rows);
	} catch {
		// the host can be hidden (0x0) while the drawer is closing
	}
}

/** The service streams terminal output; xterm is the renderer, it does not interpret anything. */
watch(
	() => store.ptyOutputSeq,
	() => {
		if (!term) return;
		// Write every queued chunk in order: a single watched string would lose the earlier ones.
		for (const chunk of store.drainPty()) term.write(chunk);
	},
);

watch(
	() => store.ptyState,
	(state) => {
		if (!term || !state) return;
		if (state.replay) {
			term.reset();
			term.write(state.replay);
			if (state.droppedChars) {
				term.write(`\r\n\x1b[2m[${state.droppedChars} earlier characters are no longer in the buffer]\x1b[0m\r\n`);
			}
		}
	},
);

watch(
	() => store.cwd,
	() => {
		// A different workspace is a different terminal; the service keeps one per workspace.
		if (term && store.cwd) store.startPty(term.cols, term.rows);
	},
);

onMounted(() => {
	if (!host.value) return;
	term = new Terminal({
		theme: THEME,
		fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
		fontSize: 12.5,
		lineHeight: 1.35,
		cursorBlink: true,
		scrollback: 5000,
		allowProposedApi: true,
		convertEol: false,
	});
	term.loadAddon(fit);
	term.open(host.value);
	term.onData((data) => store.writePty(data));
	term.attachCustomKeyEventHandler((event) => {
		// Let the app's own shortcuts through; everything else belongs to the shell.
		if (event.metaKey && (event.key === "c" || event.key === "v")) return false;
		return true;
	});
	observer = new ResizeObserver(() => fitNow());
	observer.observe(host.value);
	fitNow();
	store.startPty(term.cols, term.rows);
	term.focus();
});

onBeforeUnmount(() => {
	observer?.disconnect();
	observer = null;
	term?.dispose();
	term = null;
});

/** Give the model the screen (the terminal is deliberately not part of its context). */
function insertScreen(): void {
	if (!term) return;
	const buffer = term.buffer.active;
	const lines: string[] = [];
	const start = Math.max(0, buffer.length - 200);
	for (let index = start; index < buffer.length; index += 1) {
		lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
	}
	const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	if (text) store.insertIntoPrompt(`\`\`\`console\n${text}\n\`\`\`\n`);
}

function copyScreen(): void {
	if (!term) return;
	const buffer = term.buffer.active;
	const lines: string[] = [];
	for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
	void navigator.clipboard?.writeText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim());
}
</script>

<template>
	<div class="shell">
		<div class="shell-bar row">
			<span class="chip" :class="store.ptyRunning ? 'chip-ok' : ''">{{ store.ptyRunning ? "running" : "not running" }}</span>
			<span class="tiny faint mono ellipsis" :title="store.ptyShell">{{ store.ptyShell || "shell" }}</span>
			<span class="tiny faint">{{ store.cwd || "(no folder)" }}</span>
			<span class="spacer" />
			<button class="btn btn-sm btn-ghost" :disabled="!store.ptyRunning" @click="store.killPty(); store.startPty(100, 30)">Restart</button>
			<button class="btn btn-sm btn-ghost" @click="copyScreen()">Copy screen</button>
			<button class="btn btn-sm btn-ghost" title="The terminal is not part of the model's context" @click="insertScreen()">Insert screen into prompt</button>
		</div>
		<div ref="host" class="shell-term" />
		<div class="shell-foot tiny faint">
			A real shell with a terminal of its own: <span class="mono">cd</span>, <span class="mono">export</span>, aliases, colors and
			<span class="mono">clear</span> behave normally. It runs inside <span class="mono">{{ store.cwd || "the workspace" }}</span> and its output does
			<strong>not</strong> reach the model — use <em>Insert screen into prompt</em> for that.
		</div>
	</div>
</template>

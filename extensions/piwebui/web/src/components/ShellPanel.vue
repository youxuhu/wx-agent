<script setup lang="ts">
/**
 * The shell drawer — a terminal, not a form.
 *
 * It keeps a scrollback like a real shell: every command is echoed with a `$` prompt and its own
 * output follows it, with that run's facts (exit code, cancellation, truncation, full-log path).
 * The input sits at the bottom, Enter runs, ↑/↓ walk the command history, Esc aborts a running
 * command. Execution still goes through pi's `bash` command, so the single-writer rule and the
 * context flag behave exactly as in the terminal UI's `!`.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const scroller = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);

/** Keep the newest output in view, like a terminal that follows its own output. */
watch(
	() => [store.shellEntries.length, store.shellEntries[store.shellEntries.length - 1]?.output],
	async () => {
		await nextTick();
		const box = scroller.value;
		if (box) box.scrollTop = box.scrollHeight;
	},
	{ deep: false },
);

const last = computed(() => store.shellEntries[store.shellEntries.length - 1]);

function run(): void {
	if (!store.shellCommand.trim() || !store.cwd) return;
	store.runBash();
	void nextTick(() => input.value?.focus());
}

function key(event: KeyboardEvent): void {
	if (event.key === "ArrowUp") {
		event.preventDefault();
		store.recallShell("older");
		return;
	}
	if (event.key === "ArrowDown") {
		event.preventDefault();
		store.recallShell("newer");
		return;
	}
	if (event.key === "Escape" && store.shellRunning) {
		event.preventDefault();
		store.abortBash();
		return;
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		run();
	}
}

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// clipboard can be unavailable; the user still sees the text
	}
}
</script>

<template>
	<div class="shell">
		<div class="shell-bar row">
			<span v-if="store.shellRunning" class="chip chip-warn">running</span>
			<span v-else-if="last && last.exitCode !== null" class="chip" :class="last.exitCode === 0 ? 'chip-ok' : 'chip-danger'">exit {{ last.exitCode }}</span>
			<span v-if="last?.cancelled" class="chip chip-warn">cancelled</span>
			<span class="tiny faint">{{ store.shellEntries.length }} command(s) this session</span>
			<span class="spacer" />
			<label class="row tiny" title="pi: the output is kept out of the model's context">
				<input v-model="store.shellExcluded" type="checkbox" /><span>exclude from context</span>
			</label>
			<button class="btn btn-sm btn-ghost" :disabled="!last?.output" @click="copy(last?.output ?? '')">Copy output</button>
			<button class="btn btn-sm btn-ghost" :disabled="!store.shellEntries.length" @click="store.clearShell()">Clear</button>
		</div>

		<div ref="scroller" class="shell-body" @click="input?.focus()">
			<div v-if="!store.shellEntries.length" class="dim small">
				<p>Commands run in <span class="mono">{{ store.cwd || "(no folder)" }}</span> through pi's <code>bash</code> command — the same one the terminal UI's <code>!</code> uses.</p>
				<p class="faint">Enter runs · ↑ ↓ history · Esc stops a running command</p>
			</div>
			<div v-for="entry in store.shellEntries" :key="entry.id" class="shell-entry">
				<div class="shell-echo">
					<span class="shell-prompt">$</span>
					<span class="mono">{{ entry.command }}</span>
					<span class="spacer" />
					<span v-if="entry.running" class="chip chip-warn">running</span>
					<span v-else-if="entry.exitCode !== null" class="chip" :class="entry.exitCode === 0 ? 'chip-ok' : 'chip-danger'">exit {{ entry.exitCode }}</span>
					<span v-if="entry.cancelled" class="chip chip-warn">cancelled</span>
					<span v-if="entry.endedAt" class="tiny faint">{{ ((entry.endedAt - entry.startedAt) / 1000).toFixed(1) }}s</span>
				</div>
				<pre v-if="entry.output" class="shell-out">{{ entry.output }}</pre>
				<div class="tiny faint">
					<span v-if="entry.running && !entry.output">waiting for output…</span>
					<span v-else-if="!entry.running && !entry.output">no output</span>
					<span v-if="entry.output">{{ entry.output.length }} chars<template v-if="entry.droppedChars"> · earlier {{ entry.droppedChars }} chars dropped from the buffer</template></span>
					<span v-if="entry.truncatedByPi" class="err"> · pi truncated its response</span>
					<span v-if="entry.fullOutputPath" class="mono"> · full log: {{ entry.fullOutputPath }}</span>
				</div>
			</div>
		</div>

		<div class="shell-input">
			<span class="shell-prompt">$</span>
			<input
				ref="input"
				v-model="store.shellCommand"
				class="shell-field"
				:disabled="!store.cwd"
				:placeholder="store.cwd ? 'command…' : 'open a folder first'"
				spellcheck="false"
				autocapitalize="off"
				@keydown="key"
			/>
			<button v-if="!store.shellRunning" class="btn btn-sm" :disabled="!store.shellCommand.trim() || !store.cwd" @click="run()">Run</button>
			<button v-else class="btn btn-sm btn-danger" @click="store.abortBash()">Stop</button>
		</div>
	</div>
</template>

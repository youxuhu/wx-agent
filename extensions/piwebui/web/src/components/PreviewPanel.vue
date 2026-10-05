<script setup lang="ts">
/** Preview: iframe onto the same-origin proxy in front of a local dev server, plus picking. */
import { computed, ref, watch } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const address = ref("");
const viewport = ref<"375" | "768" | "1280" | "full">("1280");
const frame = ref<HTMLIFrameElement | null>(null);
const notes = ref<Record<string, string>>({});
const history = ref<string[]>([]);
const historyIndex = ref(-1);

const status = computed(() => store.previewInfo?.status ?? null);
/** Hot updates ride a websocket tunnel; report the observed count instead of implying it works. */
const tunnels = computed(() => store.previewInfo?.tunnels ?? null);
const tunnelText = computed(() => (tunnels.value ? `${tunnels.value.open} open tunnel(s), ${tunnels.value.refused} refused` : "not reported"));
const tunnelTitle = computed(
	() =>
		"A dev server pushes hot updates over its own websocket. The proxy forwards those upgrades to the pinned dev server only, so a page served from here can still take them.",
);
const project = computed(() => store.previewInfo?.project ?? null);
const width = computed(() => (viewport.value === "full" ? "100%" : `${viewport.value}px`));
const isFile = computed(() => store.previewUrl.startsWith("/__file/"));
const stateClass = computed(() => {
	const state = status.value?.state;
	if (state === "ready") return "chip chip-ok";
	if (state === "failed" || state === "exited") return "chip chip-danger";
	return "chip";
});

function go(): void {
	const resolved = store.navigate(address.value);
	if (!resolved) return;
	history.value = [...history.value.slice(0, historyIndex.value + 1), resolved];
	historyIndex.value = history.value.length - 1;
}

function step(delta: number): void {
	const next = historyIndex.value + delta;
	const target = history.value[next];
	if (!target) return;
	historyIndex.value = next;
	store.previewUrl = target;
	address.value = target;
}

function applyPickMode(): void {
	frame.value?.contentWindow?.postMessage({ type: "piwebui:pick-mode", on: store.pickMode }, location.origin);
}

watch(() => store.pickMode, applyPickMode);
</script>

<template>
	<div class="pane">
		<div class="row">
			<span :class="stateClass">{{ status?.state ?? "unknown" }}</span>
			<span v-if="status?.port" class="chip">:{{ status.port }}</span>
			<span v-if="isFile" class="chip">file (read-only)</span>
			<button class="btn btn-sm btn-ghost" :disabled="historyIndex <= 0" @click="step(-1)">←</button>
			<button class="btn btn-sm btn-ghost" :disabled="historyIndex >= history.length - 1" @click="step(1)">→</button>
		</div>

		<div class="row-nowrap">
			<input v-model="address" class="field" placeholder="http://127.0.0.1:5173/ or file:///abs/index.html" @keydown.enter="go()" />
			<button class="btn btn-sm" @click="go()">Go</button>
			<button class="btn btn-sm" @click="store.reloadPreview()">Reload</button>
		</div>

		<div class="row">
			<button v-for="size in (['375', '768', '1280', 'full'] as const)" :key="size" class="tab" :class="{ active: viewport === size }" @click="viewport = size">
				{{ size }}
			</button>
			<span class="spacer" />
			<label class="row tiny">
				<input :checked="store.pickMode" type="checkbox" @change="store.setPickMode(($event.target as HTMLInputElement).checked)" />
				<span>pick element</span>
			</label>
		</div>

		<div class="row">
			<template v-if="status?.command">
				<button class="btn btn-sm" :disabled="status.state === 'starting' || status.state === 'ready'" @click="store.devStart()">Start dev</button>
				<button class="btn btn-sm" :disabled="!status.pid" @click="store.devStop()">Stop</button>
				<span class="tiny faint ellipsis">{{ status.command }}</span>
			</template>
			<span v-else class="tiny faint">no dev command in preview.json — start your own server and point the address above at it</span>
		</div>

		<p v-if="store.previewError" class="fact err">{{ store.previewError }}</p>
		<p v-else-if="status?.error" class="fact err">{{ status.error }}</p>
		<p v-else-if="status?.readyVia" class="fact tiny">ready via {{ status.readyVia }}</p>
		<!-- Facts, not a promise: the tunnel counter says whether hot updates can actually reach the page. -->
		<p class="fact tiny" :title="tunnelTitle">websocket: {{ tunnelText }}</p>

		<div class="frame-wrap">
			<iframe :key="store.previewFrameKey" ref="frame" :src="store.previewUrl || 'about:blank'" :style="{ width }" @load="applyPickMode" />
		</div>

		<div class="row">
			<span class="chip">{{ store.picks.length }} picked</span>
			<button class="btn btn-sm btn-ghost" :disabled="!store.picks.length" @click="store.clearPicks()">Clear</button>
			<button class="btn btn-sm" :disabled="!store.picks.length" @click="store.insertIntoPrompt(store.picks.map(store.pickFacts).join('\n\n'))">
				Insert all into prompt
			</button>
		</div>

		<div v-for="pick in store.picks" :key="pick.id" class="list">
			<div class="list-row">
				<span class="chip" :class="pick.payload.selectorUnique ? 'chip-ok' : 'chip-warn'">
					{{ pick.payload.selectorUnique ? "unique" : `${pick.payload.selectorMatches} matches` }}
				</span>
				<span class="tiny faint">{{ pick.at }}</span>
				<span class="mono tiny ellipsis">{{ pick.payload.selector }}</span>
				<span class="spacer" />
				<button class="btn btn-sm btn-ghost" @click="store.insertIntoPrompt(store.pickFacts(pick))">Insert</button>
				<button class="btn btn-sm btn-ghost" @click="store.removePick(pick.id)">Remove</button>
			</div>
			<div class="list-row">
				<span class="tiny dim ellipsis">{{ pick.payload.text || "(no text)" }}</span>
			</div>
			<div class="list-row">
				<input
					class="field"
					:value="notes[pick.id] ?? pick.note"
					placeholder="note about this element (optional)…"
					@input="notes[pick.id] = ($event.target as HTMLInputElement).value; store.setPickNote(pick.id, notes[pick.id])"
				/>
			</div>
		</div>

		<details v-if="status?.log?.length">
			<summary class="tiny dim">dev server output</summary>
			<pre class="code-block">{{ status.log.slice(-25).join("\n") }}</pre>
		</details>
	</div>
</template>

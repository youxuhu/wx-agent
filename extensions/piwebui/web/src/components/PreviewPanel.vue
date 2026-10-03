<script setup lang="ts">
/**
 * Preview panel: an iframe onto the same-origin proxy in front of a local dev server,
 * plus read-only local files. Facts only — the state of the dev server, the upstream
 * that answered and every refusal come straight from the service.
 */
import { computed, ref, watch } from "vue";
import { Button, Collapse, CollapseItem, Input, Space, Tag, Textarea, Tooltip } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();

const address = ref("");
const viewport = ref<"375" | "768" | "1280" | "full">("1280");
const frame = ref<HTMLIFrameElement | null>(null);
const noteDraft = ref<Record<string, string>>({});
const history = ref<string[]>([]);
const historyIndex = ref(-1);

const status = computed(() => store.previewInfo?.status ?? null);
const project = computed(() => store.previewInfo?.project ?? null);
const stateTheme = computed(() => {
	const value = status.value?.state;
	if (value === "ready") return "success";
	if (value === "starting") return "warning";
	if (value === "failed" || value === "exited") return "danger";
	return "notice";
});
const isFilePreview = computed(() => store.previewUrl.startsWith("/__file/"));
const width = computed(() => (viewport.value === "full" ? "100%" : `${viewport.value}px`));

function go(input?: string): void {
	const value = input ?? address.value;
	const resolved = store.navigate(value);
	if (!resolved) return;
	address.value = value;
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

function onFrameLoad(): void {
	applyPickMode();
}

/** The picker only listens while the parent says so; re-arm after every navigation. */
function applyPickMode(): void {
	const target = frame.value?.contentWindow;
	if (!target) return;
	target.postMessage({ type: "piwebui:pick-mode", on: store.pickMode }, location.origin);
}

watch(() => store.pickMode, applyPickMode);

function copyFacts(id: string): void {
	const pick = store.picks.find((item) => item.id === id);
	if (!pick) return;
	store.insertIntoPrompt(store.pickFacts(pick));
}
</script>

<template>
	<section class="preview">
		<div class="bar">
			<Tag :theme="stateTheme" size="small">{{ status?.state ?? "unknown" }}</Tag>
			<Tag v-if="status?.port" theme="notice" size="small">:{{ status.port }}</Tag>
			<Tag v-if="status?.httpStatus" size="small">http {{ status.httpStatus }}</Tag>
			<Tag v-if="isFilePreview" size="small">file (read-only)</Tag>
			<Button size="small" variant="text" @click="step(-1)" :disabled="historyIndex <= 0">←</Button>
			<Button size="small" variant="text" @click="step(1)" :disabled="historyIndex >= history.length - 1">→</Button>
			<Input v-model="address" size="small" placeholder="http://127.0.0.1:5173/ or file:///abs/index.html" @keydown.enter="go()" />
			<Button size="small" @click="go()">go</Button>
			<Button size="small" variant="outline" @click="store.reloadPreview()">reload</Button>
		</div>

		<div class="bar">
			<Space>
				<Button size="small" variant="text" @click="viewport = '375'">375</Button>
				<Button size="small" variant="text" @click="viewport = '768'">768</Button>
				<Button size="small" variant="text" @click="viewport = '1280'">1280</Button>
				<Button size="small" variant="text" @click="viewport = 'full'">full</Button>
			</Space>
			<Tooltip content="pick an element in the page: it is reported with selector, uniqueness, text, rect and a sanitized HTML snippet">
				<Button size="small" :variant="store.pickMode ? 'primary' : 'outline'" @click="store.setPickMode(!store.pickMode)">
					{{ store.pickMode ? "picking…" : "pick element" }}
				</Button>
			</Tooltip>
			<Space v-if="!status?.command">
				<span class="dim">no dev command in preview.json</span>
			</Space>
			<Space v-else>
				<Button size="small" :disabled="status.state === 'starting' || status.state === 'ready'" @click="store.devStart()">start dev</Button>
				<Button size="small" variant="outline" :disabled="!status.pid" @click="store.devStop()">stop</Button>
				<span class="dim ellipsis">{{ status.command }}</span>
			</Space>
		</div>

		<p v-if="store.previewError" class="fact err">{{ store.previewError }}</p>
		<p v-else-if="status?.error" class="fact err">{{ status.error }}</p>
		<p v-else-if="status?.readyVia" class="fact dim">ready via {{ status.readyVia }} · cwd {{ status.cwd }}</p>
		<p v-else-if="!project?.configured" class="fact dim">
			preview.json has no entry for {{ status?.cwd ?? "this cwd" }} — start your dev server yourself and point the address bar at it
		</p>

		<div class="stage">
			<iframe
				:key="store.previewFrameKey"
				ref="frame"
				:src="store.previewUrl || 'about:blank'"
				:style="{ width }"
				class="frame"
				@load="onFrameLoad"
			/>
		</div>

		<div class="picks">
			<div class="bar">
				<Tag size="small">{{ store.picks.length }} picked</Tag>
				<Button size="small" variant="text" :disabled="!store.picks.length" @click="store.clearPicks()">clear</Button>
				<Button
					size="small"
					variant="outline"
					:disabled="!store.picks.length"
					@click="store.insertIntoPrompt(store.picks.map(store.pickFacts).join('\n\n'))"
				>
					insert all into prompt
				</Button>
			</div>
			<div v-for="pick in store.picks" :key="pick.id" class="pick">
				<div class="pick-head">
					<Tag size="small" :theme="pick.payload.selectorUnique ? 'success' : 'warning'">
						{{ pick.payload.selectorUnique ? "unique" : `${pick.payload.selectorMatches} matches` }}
					</Tag>
					<span class="dim">{{ pick.at }}</span>
					<span class="ellipsis mono">{{ pick.payload.selector }}</span>
					<Space class="pick-actions">
						<Button size="small" variant="text" @click="copyFacts(pick.id)">insert</Button>
						<Button size="small" variant="text" @click="store.removePick(pick.id)">remove</Button>
					</Space>
				</div>
				<div class="dim ellipsis2">{{ pick.payload.text || "(no text)" }}</div>
				<Textarea
					:model-value="noteDraft[pick.id] ?? pick.note"
					:rows="2"
					placeholder="note about this element (optional)…"
					@update:model-value="(value: string) => { noteDraft[pick.id] = value; store.setPickNote(pick.id, value); }"
				/>
			</div>
		</div>

		<Collapse v-if="status?.log?.length" :model-value="[]">
			<CollapseItem title="dev server output (last lines)" name="log">
				<pre class="log">{{ status.log.slice(-20).join("\n") }}</pre>
			</CollapseItem>
		</Collapse>
	</section>
</template>

<style scoped>
.preview {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
	min-height: 0;
	height: 100%;
	overflow: auto;
}

.bar {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
}

.stage {
	flex: 1;
	min-height: 240px;
	border: 2px solid var(--px-neutral-6);
	overflow: auto;
	background: #fff;
}

.frame {
	display: block;
	height: 100%;
	min-height: 240px;
	border: 0;
	margin: 0 auto;
}

.picks {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.pick {
	border: 1px solid var(--px-neutral-6);
	padding: 4px 6px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.pick-head {
	display: flex;
	align-items: center;
	gap: 6px;
}

.pick-actions {
	margin-left: auto;
}

.fact {
	margin: 0;
	font-size: 12px;
}

.err {
	color: var(--px-danger-6, #b91c1c);
}

.mono {
	font-family: var(--px-font, monospace);
}

.ellipsis {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 40vw;
}

.ellipsis2 {
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.log {
	margin: 0;
	max-height: 160px;
	overflow: auto;
	font-size: 12px;
	white-space: pre-wrap;
}
</style>

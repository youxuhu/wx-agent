<script setup lang="ts">
/** Read-only project tree with git status letters. Native controls only. */
import { computed, onMounted, ref, watch } from "vue";
import { renderMarkdown } from "../markdown.ts";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const MAX_DEPTH = 6;
/** Markdown files can be shown rendered or raw; rendering escapes all source text first. */
const mode = ref<"rendered" | "raw">("rendered");

/**
 * Start editing from the bytes we actually read. The draft is seeded from the *full* text (the
 * code block above truncates only for display), and the read's mtime/size travel with the save.
 */
function startEditing(): void {
	if (!store.fileView) return;
	store.fileDraft = store.fileView.text;
	store.fileSaveError = "";
	store.fileEditing = true;
}

const isMarkdown = computed(() => {
	const path = store.fileView?.path ?? "";
	return /\.(md|markdown|mdx)$/i.test(path);
});
const rendered = computed(() => (store.fileView ? renderMarkdown(store.fileView.text) : ""));

interface Row {
	name: string;
	path: string;
	type: string;
	depth: number;
	ignored?: boolean;
	label: string;
}

const rows = computed<Row[]>(() => {
	const out: Row[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > MAX_DEPTH) return;
		for (const entry of store.treeChildren[dir] ?? []) {
			if (entry.ignored && !store.showIgnoredFiles) continue;
			out.push({ name: entry.name, path: entry.path, type: entry.type, depth, ignored: entry.ignored, label: statusLabel(entry.path) });
			if ((entry.type === "dir" || entry.type === "symlink") && store.treeExpanded.includes(entry.path)) walk(entry.path, depth + 1);
		}
	};
	walk(store.cwd, 0);
	return out;
});

function statusLabel(path: string): string {
	const status = store.gitStatus;
	if (!status?.repo || !status.root) return "";
	const root = status.root.endsWith("/") ? status.root : `${status.root}/`;
	if (!path.startsWith(root)) return "";
	const relative = path.slice(root.length);
	const entry = status.entries.find((item) => item.path === relative || item.path === `${relative}/`);
	if (!entry) return "";
	if (entry.untracked) return "U";
	const worktree = entry.worktree === "." ? "" : entry.worktree;
	const index = entry.index === "." ? "" : entry.index;
	return (worktree || index).slice(0, 1);
}

function onRow(row: Row): void {
	mode.value = "rendered";
	if (row.type === "dir" || row.type === "symlink") store.toggleDir(row.path);
	else store.openFileAt(row.path);
}

onMounted(() => {
	store.loadTree(store.cwd);
	if (!store.gitStatus) store.refreshGit();
});

watch(
	() => store.cwd,
	(cwd) => {
		if (cwd && !store.treeChildren[cwd]) store.loadTree(cwd);
	},
);

watch(
	() => store.showIgnoredFiles,
	() => store.reloadTree(),
);
</script>

<template>
	<div class="pane">
		<div class="row">
			<button class="btn btn-sm" @click="store.reloadTree()">Reload</button>
			<label class="row tiny">
				<input v-model="store.showIgnoredFiles" type="checkbox" />
				<span>show ignored</span>
			</label>
			<span class="spacer" />
			<span class="tiny faint ellipsis">{{ store.cwd }}</span>
		</div>

		<p v-if="store.fileError" class="fact err">{{ store.fileError }}</p>

		<div class="list">
			<div
				v-for="row in rows"
				:key="row.path"
				class="list-row clickable"
				:class="{ 'entry-ignored': row.ignored }"
				:style="{ paddingLeft: `${9 + row.depth * 14}px` }"
				@click="onRow(row)"
			>
				<span class="tree-caret">{{ row.type === "dir" ? (store.treeExpanded.includes(row.path) ? "▾" : "▸") : row.type === "symlink" ? "@" : "" }}</span>
				<span class="ellipsis">{{ row.name }}</span>
				<span v-if="row.label" class="chip chip-warn">{{ row.label }}</span>
			</div>
			<div v-if="!rows.length" class="list-row faint">empty</div>
		</div>

		<div v-if="store.fileView" class="col">
			<div class="row tiny faint">
				<span class="mono">{{ store.fileView.path }}</span>
				<span>{{ store.fileView.bytes }} bytes</span>
				<span v-if="store.fileView.mtimeMs" class="faint">{{ new Date(store.fileView.mtimeMs).toISOString().slice(11, 19) }}</span>
				<button class="btn btn-sm btn-ghost spacer" @click="store.navigate(`file://${store.fileView?.path ?? ''}`); store.drawer = 'preview'">Render</button>
				<button
					v-if="!store.fileEditing"
					class="btn btn-sm"
					title="edit the file in place; saving sends the mtime/size it was read with, so a file changed on disk is refused instead of overwritten"
					@click="startEditing"
				>
					Edit
				</button>
				<template v-else>
					<button class="btn btn-sm btn-primary" :disabled="store.fileSaving" @click="store.saveFile()">
						{{ store.fileSaving ? "Saving…" : "Save" }}
					</button>
					<button class="btn btn-sm btn-ghost" @click="store.fileEditing = false">Cancel</button>
					<button class="btn btn-sm btn-ghost" title="re-read from disk (discards the editor)" @click="store.reloadFile()">Reload</button>
					<span class="tiny faint">{{ store.fileDraft.length }} chars in the editor</span>
				</template>
			</div>
			<p v-if="store.fileSaveError" class="fact err">{{ store.fileSaveError }}</p>
			<div v-if="isMarkdown" class="row">
				<button class="tab" :class="{ active: mode === 'rendered' }" @click="mode = 'rendered'">Rendered</button>
				<button class="tab" :class="{ active: mode === 'raw' }" @click="mode = 'raw'">Raw</button>
			</div>
			<div v-if="isMarkdown && mode === 'rendered' && !store.fileEditing" class="markdown" v-html="rendered" />
			<textarea v-else-if="store.fileEditing" v-model="store.fileDraft" class="textarea code-edit" spellcheck="false" />
			<pre v-else class="code-block">{{ store.fileView.text.slice(0, 200_000) }}</pre>
		</div>
	</div>
</template>

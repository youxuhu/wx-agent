<script setup lang="ts">
/**
 * Read-only project tree. Paths are absolute (the service resolves them against the
 * workspace); the panel never sends a path of its own.
 */
import { computed, onMounted, watch } from "vue";
import { Button, Space, Switch, Tag, Tooltip } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();

interface Row {
	name: string;
	path: string;
	type: "dir" | "file" | "symlink" | "other";
	depth: number;
	ignored?: boolean;
	label: string;
}

const MAX_DEPTH = 6;

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

/** Git status letters for a path, from the same data the changes panel shows. */
function statusLabel(path: string): string {
	const status = store.gitStatus;
	if (!status?.repo || !status.root) return "";
	const root = status.root.endsWith("/") ? status.root : `${status.root}/`;
	if (!path.startsWith(root)) return "";
	const relative = path.slice(root.length);
	const entry = status.entries.find((item) => item.path === relative || item.path === `${relative}/`);
	if (!entry) return "";
	if (entry.untracked) return "U";
	const index = entry.index === "." ? "" : entry.index;
	const worktree = entry.worktree === "." ? "" : entry.worktree;
	return (worktree || index).slice(0, 1);
}

function onRow(row: Row): void {
	if (row.type === "dir" || row.type === "symlink") store.toggleDir(row.path);
	else store.openFileAt(row.path);
}

onMounted(() => {
	store.loadTree(store.cwd);
	if (!store.gitStatus) store.refreshGit();
});

// The workspace path arrives with the first server message, so load the root as soon as it does.
watch(
	() => store.cwd,
	(cwd) => {
		if (cwd && !store.treeChildren[cwd]) store.loadTree(cwd);
	},
);
</script>

<template>
	<div class="panel">
		<Space>
			<Button size="small" variant="outline" @click="store.reloadTree()">reload</Button>
			<Tag size="small">{{ store.cwd }}</Tag>
			<Tooltip content="ignored entries come from `git check-ignore`; showing them is a toggle, not a filter change">
				<span class="row">
					<span class="dim">ignored</span>
					<Switch v-model="store.showIgnoredFiles" size="small" />
				</span>
			</Tooltip>
		</Space>

		<p v-if="store.fileError" class="fact err">{{ store.fileError }}</p>

		<div class="tree">
			<div
				v-for="row in rows"
				:key="row.path"
				class="row entry"
				:class="{ dir: row.type === 'dir', ignored: row.ignored }"
				:style="{ paddingLeft: `${4 + row.depth * 12}px` }"
				@click="onRow(row)"
			>
				<span class="caret">{{ row.type === "dir" ? (store.treeExpanded.includes(row.path) ? "▾" : "▸") : row.type === "symlink" ? "@" : " " }}</span>
				<span class="name">{{ row.name }}</span>
				<Tag v-if="row.label" size="small" theme="warning">{{ row.label }}</Tag>
			</div>
			<p v-if="!rows.length" class="dim">empty</p>
		</div>

		<div v-if="store.fileView" class="preview">
			<div class="row head">
				<Tag size="small">{{ store.fileView.language ?? "text" }}</Tag>
				<span class="dim ellipsis">{{ store.fileView.path }}</span>
				<span class="dim">{{ store.fileView.bytes }} bytes</span>
				<Tooltip content="render it through the preview panel instead (read-only, same file API)">
					<Button size="small" variant="text" @click="store.navigate(`file://${store.fileView?.path ?? ''}`); store.showPreview = true">preview</Button>
				</Tooltip>
			</div>
			<pre class="text">{{ store.fileView.text.slice(0, 200_000) }}</pre>
		</div>
	</div>
</template>

<style scoped>
.panel {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-height: 0;
	height: 100%;
	overflow: auto;
}

.tree {
	border: 1px solid var(--px-neutral-5, #ddd);
	overflow: auto;
	max-height: 50vh;
}

.row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.entry {
	cursor: pointer;
	white-space: nowrap;
}

.entry:hover {
	background: var(--px-neutral-2, #f4f4f4);
}

.entry.ignored .name {
	color: var(--px-neutral-6, #999);
}

.caret {
	width: 10px;
	color: var(--px-neutral-7, #888);
}

.head {
	flex-wrap: wrap;
}

.preview {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.text {
	margin: 0;
	font-family: var(--px-font, monospace);
	font-size: 12px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: 40vh;
	overflow: auto;
	border: 1px solid var(--px-neutral-5, #ddd);
	padding: 4px;
}

.ellipsis {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 200px;
}

.fact {
	margin: 0;
	font-size: 12px;
}

.err {
	color: #b91c1c;
}
</style>

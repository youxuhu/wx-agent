<script setup lang="ts">
/** Read-only project tree with git status letters. Native controls only. */
import { computed, onMounted, watch } from "vue";
import { useSessionStore } from "../stores/session.ts";

const store = useSessionStore();
const MAX_DEPTH = 6;

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
				<button class="btn btn-sm btn-ghost spacer" @click="store.navigate(`file://${store.fileView?.path ?? ''}`); store.drawer = 'preview'">Render</button>
			</div>
			<pre class="code-block">{{ store.fileView.text.slice(0, 200_000) }}</pre>
		</div>
	</div>
</template>

<script setup lang="ts">
/**
 * Source-control panel: staged / unstaged / untracked, diffs, commit.
 *
 * The service composes every git argv; this panel only picks which files an action applies
 * to. Destructive actions (discard) go through an explicit confirmation, and the service
 * takes a snapshot ref first — the ref is reported back as a fact.
 */
import { computed } from "vue";
import { Button, Dialog, Space, Switch, Tag, Textarea, Tooltip } from "@pixelium/web-vue";
import { useSessionStore } from "../stores/session.ts";
import DiffView from "./DiffView.vue";

const store = useSessionStore();

const staged = computed(() => (store.gitStatus?.entries ?? []).filter((entry) => entry.staged && !entry.conflicted));
const unstaged = computed(() => (store.gitStatus?.entries ?? []).filter((entry) => entry.conflicted || (!entry.untracked && entry.unstaged)));
const untracked = computed(() => (store.gitStatus?.entries ?? []).filter((entry) => entry.untracked));

const letters = (indexStatus: string, worktree: string): string => {
	const index = indexStatus === "." ? " " : indexStatus;
	const work = worktree === "." ? " " : worktree;
	return `${index}${work}`;
};
</script>

<template>
	<div class="panel">
		<p v-if="!store.gitStatus" class="dim">reading git status…</p>
		<p v-else-if="!store.gitStatus.repo" class="fact">
			{{ store.cwd }} is not a git repository{{ store.gitStatus.error ? ` — ${store.gitStatus.error}` : "" }}
		</p>

		<template v-else>
			<div class="row head">
				<Tag size="small">⎇ {{ store.gitStatus.branch ?? "(detached)" }}</Tag>
				<Tag v-if="store.gitStatus.upstream" size="small" theme="notice">↑{{ store.gitStatus.ahead }} ↓{{ store.gitStatus.behind }}</Tag>
				<Tag v-if="store.gitStatus.root !== store.cwd" size="small">root: {{ store.gitStatus.root }}</Tag>
				<Button size="small" variant="outline" @click="store.refreshGit()">refresh</Button>
			</div>

			<div class="commit">
				<Textarea v-model="store.gitMessage" :rows="2" placeholder="commit message (staged changes only)…" />
				<Space>
					<Button size="small" :disabled="!store.gitMessage.trim()" @click="store.commitGit()">commit</Button>
					<Tooltip content="amend rewrites the last commit; the service snapshots the tree into refs/piwebui/* first">
						<span class="row"><span class="dim">amend</span><Switch v-model="store.gitAmend" size="small" /></span>
					</Tooltip>
					<Button size="small" variant="outline" :disabled="!untracked.length" @click="store.stagePaths(untracked.map((e) => e.path))">stage all untracked</Button>
				</Space>
			</div>

			<section v-if="staged.length">
				<h4>staged ({{ staged.length }})</h4>
				<div v-for="entry in staged" :key="`s-${entry.path}`" class="row entry">
					<Tag size="small" theme="success">{{ letters(entry.index, entry.worktree) }}</Tag>
					<span class="path" @click="store.loadDiff(entry.path, true)">{{ entry.path }}</span>
					<Button size="small" variant="text" @click="store.loadDiff(entry.path, true)">diff</Button>
					<Button size="small" variant="text" @click="store.unstagePaths([entry.path])">unstage</Button>
				</div>
			</section>

			<section v-if="unstaged.length">
				<h4>changes ({{ unstaged.length }})</h4>
				<div v-for="entry in unstaged" :key="`u-${entry.path}`" class="row entry">
					<Tag size="small" :theme="entry.conflicted ? 'danger' : 'warning'">{{ letters(entry.index, entry.worktree) }}</Tag>
					<span class="path" @click="store.loadDiff(entry.path, false)">{{ entry.path }}</span>
					<Button size="small" variant="text" @click="store.loadDiff(entry.path, false)">diff</Button>
					<Button size="small" variant="text" @click="store.stagePaths([entry.path])">stage</Button>
					<Button size="small" variant="text" theme="danger" @click="store.requestDiscard([entry.path])">discard</Button>
				</div>
			</section>

			<section v-if="untracked.length">
				<h4>untracked ({{ untracked.length }})</h4>
				<div v-for="entry in untracked" :key="`n-${entry.path}`" class="row entry">
					<Tag size="small">??</Tag>
					<span class="path" @click="store.openFileAt(`${store.gitStatus?.root}/${entry.path}`)">{{ entry.path }}</span>
					<Button size="small" variant="text" @click="store.stagePaths([entry.path])">stage</Button>
					<span class="dim">not deletable here</span>
				</div>
			</section>

			<p v-if="!staged.length && !unstaged.length && !untracked.length" class="dim">working tree clean</p>
		</template>

		<p v-if="store.gitNotice" class="fact">{{ store.gitNotice }}</p>

		<div v-if="store.gitDiff" class="diffwrap">
			<div class="row head">
				<Tag size="small" :theme="store.gitDiff.staged ? 'success' : 'warning'">{{ store.gitDiff.staged ? "staged" : "worktree" }}</Tag>
				<span class="dim ellipsis">{{ store.gitDiff.path }}</span>
				<Button size="small" variant="text" @click="store.gitDiff = null">close</Button>
			</div>
			<DiffView v-if="store.gitDiff.ok" :text="store.gitDiff.text || '(no textual diff)'" />
			<p v-else class="fact err">{{ store.gitDiff.error }}</p>
		</div>

		<Dialog :visible="Boolean(store.gitConfirm)" title="discard changes?" :mask-closable="true" @update:visible="(v: boolean) => { if (!v) store.gitConfirm = null; }">
			<p class="fact">
				这会丢弃 {{ store.gitConfirm?.paths.length ?? 0 }} 个文件的**未提交改动**（工作区 + 暂存区）。服务会先把当前工作树快照到 <code>refs/piwebui/&lt;时间戳&gt;</code>，并在结果里回传该 ref；丢弃后仍可用
				<code>git show &lt;ref&gt;</code> 找回。
			</p>
			<pre class="paths">{{ (store.gitConfirm?.paths ?? []).join("\n") }}</pre>
			<Space>
				<Button size="small" theme="danger" @click="store.confirmDiscard()">discard (snapshot first)</Button>
				<Button size="small" variant="outline" @click="store.gitConfirm = null">cancel</Button>
			</Space>
		</Dialog>
	</div>
</template>

<style scoped>
.panel {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-height: 0;
	overflow: auto;
}

.row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.head {
	flex-wrap: wrap;
}

.entry {
	border-bottom: 1px solid var(--px-neutral-3, #eee);
}

.commit {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

h4 {
	margin: 4px 0 2px;
	font-size: 13px;
	color: var(--px-neutral-9, #333);
}

.path {
	cursor: pointer;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 42%;
}

.diffwrap {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.fact {
	margin: 0;
	font-size: 12px;
}

.err {
	color: #b91c1c;
}

.dim {
	color: var(--px-neutral-8, #666);
	font-size: 12px;
}

.paths {
	margin: 4px 0;
	max-height: 120px;
	overflow: auto;
	font-size: 12px;
}

.ellipsis {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 200px;
}
</style>

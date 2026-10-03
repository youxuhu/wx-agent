<script setup lang="ts">
/**
 * Source control: staged / changes / untracked, diffs, commit.
 * The service composes every git argv; discard needs confirmation and snapshots first.
 */
import { computed } from "vue";
import { useSessionStore } from "../stores/session.ts";
import DiffView from "./DiffView.vue";

const store = useSessionStore();

const staged = computed(() => (store.gitStatus?.entries ?? []).filter((entry) => entry.staged && !entry.conflicted));
const unstaged = computed(() => (store.gitStatus?.entries ?? []).filter((entry) => entry.conflicted || (!entry.untracked && entry.unstaged)));
const untracked = computed(() => (store.gitStatus?.entries ?? []).filter((entry) => entry.untracked));

const letters = (index: string, worktree: string): string => `${index === "." ? " " : index}${worktree === "." ? " " : worktree}`;
</script>

<template>
	<div class="pane">
		<p v-if="!store.gitStatus" class="fact">reading git status…</p>
		<p v-else-if="!store.gitStatus.repo" class="fact">{{ store.cwd }} is not a git repository{{ store.gitStatus.error ? ` — ${store.gitStatus.error}` : "" }}</p>

		<template v-else>
			<div class="row">
				<span class="chip">⎇ {{ store.gitStatus.branch ?? "(detached)" }}</span>
				<span v-if="store.gitStatus.upstream" class="chip">↑{{ store.gitStatus.ahead }} ↓{{ store.gitStatus.behind }}</span>
				<button class="btn btn-sm spacer" @click="store.refreshGit()">Refresh</button>
			</div>

			<textarea v-model="store.gitMessage" class="textarea" :rows="2" placeholder="Commit message (staged changes only)…" />
			<div class="row">
				<button class="btn btn-sm btn-primary" :disabled="!store.gitMessage.trim()" @click="store.commitGit()">Commit</button>
				<label class="row tiny"><input v-model="store.gitAmend" type="checkbox" /><span>amend last commit</span></label>
				<button class="btn btn-sm spacer" :disabled="!untracked.length" @click="store.stagePaths(untracked.map((e) => e.path))">Stage all untracked</button>
			</div>

			<template v-if="staged.length">
				<h4>Staged · {{ staged.length }}</h4>
				<div class="list">
					<div v-for="entry in staged" :key="`s-${entry.path}`" class="list-row">
						<span class="chip chip-ok mono">{{ letters(entry.index, entry.worktree) }}</span>
						<span class="ellipsis mono" @click="store.loadDiff(entry.path, true)">{{ entry.path }}</span>
						<span class="spacer" />
						<button class="btn btn-sm btn-ghost" @click="store.loadDiff(entry.path, true)">Diff</button>
						<button class="btn btn-sm btn-ghost" @click="store.unstagePaths([entry.path])">Unstage</button>
					</div>
				</div>
			</template>

			<template v-if="unstaged.length">
				<h4>Changes · {{ unstaged.length }}</h4>
				<div class="list">
					<div v-for="entry in unstaged" :key="`u-${entry.path}`" class="list-row">
						<span class="chip mono" :class="entry.conflicted ? 'chip-danger' : 'chip-warn'">{{ letters(entry.index, entry.worktree) }}</span>
						<span class="ellipsis mono" @click="store.loadDiff(entry.path, false)">{{ entry.path }}</span>
						<span class="spacer" />
						<button class="btn btn-sm btn-ghost" @click="store.loadDiff(entry.path, false)">Diff</button>
						<button class="btn btn-sm btn-ghost" @click="store.stagePaths([entry.path])">Stage</button>
						<button class="btn btn-sm btn-ghost btn-danger" @click="store.requestDiscard([entry.path])">Discard</button>
					</div>
				</div>
			</template>

			<template v-if="untracked.length">
				<h4>Untracked · {{ untracked.length }}</h4>
				<div class="list">
					<div v-for="entry in untracked" :key="`n-${entry.path}`" class="list-row">
						<span class="chip mono">??</span>
						<span class="ellipsis mono" @click="store.openFileAt(`${store.gitStatus?.root}/${entry.path}`)">{{ entry.path }}</span>
						<span class="spacer" />
						<button class="btn btn-sm btn-ghost" @click="store.stagePaths([entry.path])">Stage</button>
					</div>
				</div>
			</template>

			<p v-if="!staged.length && !unstaged.length && !untracked.length" class="fact">Working tree clean.</p>
		</template>

		<p v-if="store.gitNotice" class="fact">{{ store.gitNotice }}</p>

		<div v-if="store.gitDiff" class="col">
			<div class="row tiny">
				<span class="chip" :class="store.gitDiff.staged ? 'chip-ok' : 'chip-warn'">{{ store.gitDiff.staged ? "staged" : "worktree" }}</span>
				<span class="mono ellipsis">{{ store.gitDiff.path }}</span>
				<button class="btn btn-sm btn-ghost spacer" @click="store.gitDiff = null">Close</button>
			</div>
			<DiffView v-if="store.gitDiff.ok" :text="store.gitDiff.text || '(no textual diff)'" />
			<p v-else class="fact err">{{ store.gitDiff.error }}</p>
		</div>

		<div v-if="store.gitConfirm" class="overlay">
			<div class="modal">
				<h3>Discard changes?</h3>
				<p class="fact">
					This throws away the uncommitted changes of {{ store.gitConfirm.paths.length }} path(s) (worktree and index). The service snapshots the
					tree to <code>refs/piwebui/&lt;timestamp&gt;</code> first and reports that ref back, so it stays recoverable.
				</p>
				<pre class="code-block">{{ store.gitConfirm.paths.join("\n") }}</pre>
				<div class="row">
					<button class="btn btn-danger" @click="store.confirmDiscard()">Discard (snapshot first)</button>
					<button class="btn" @click="store.gitConfirm = null">Cancel</button>
				</div>
			</div>
		</div>
	</div>
</template>

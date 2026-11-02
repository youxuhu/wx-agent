/**
 * Language servers install themselves.
 *
 * pi-lsp needs `typescript-language-server` and `pyright-langserver`. Pointing at whatever happens
 * to be on PATH makes every machine different, and asking people to remember a script means it
 * gets skipped — so the pins live in `lsp/package.json` (tracked) and this extension reconciles the
 * installed tree with them.
 *
 * Rules (all of them exist to keep startup boring):
 *  - the check is a few file reads and runs **in the background** — startup never waits for npm;
 *  - npm only runs when a pinned version is actually missing or different (`npm ci` when the lock
 *    file is there, so the tree is reproducible);
 *  - one attempt per process, guarded by a lock file, so a desktop app and a CLI do not race;
 *  - `PI_LSP_AUTOINSTALL=off` skips it entirely (offline/CI), and a failure is reported once, as a
 *    fact with the log path — never retried in a loop;
 *  - `pi-lsp.json` is only written when it is **absent** (it is machine-local, gitignored);
 *  - there is no manual command to run: startup is the only entry point, so a machine either has
 *    its language servers or it reports why it does not.
 */
import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { configFor, configPointsAtTree, drift, hasPins, lspPaths, pinned } from './lsp-tree.mjs';

const ROOT = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const LOG = join(ROOT, 'logs', 'lsp-bootstrap.log');
const LOCK = join(ROOT, 'lsp', '.bootstrap.lock');
const TIMEOUT_MS = 5 * 60 * 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;

function disabled(): boolean {
	const value = (process.env.PI_LSP_AUTOINSTALL ?? '').trim().toLowerCase();
	return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** Take the install lock; a lock older than STALE_LOCK_MS is treated as abandoned. */
async function takeLock(): Promise<boolean> {
	try {
		const raw = await fs.readFile(LOCK, 'utf8');
		const age = Date.now() - Number(JSON.parse(raw).at ?? 0);
		if (Number.isFinite(age) && age < STALE_LOCK_MS) return false;
	} catch {
		/* no lock: free to take it */
	}
	try {
		await fs.writeFile(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: 'utf8', flag: 'w' });
		return true;
	} catch {
		return false;
	}
}

async function releaseLock(): Promise<void> {
	await fs.rm(LOCK, { force: true }).catch(() => undefined);
}

/** Write pi-lsp.json only when it does not exist yet (machine-local file). */
async function ensureConfig(): Promise<boolean> {
	const path = lspPaths(ROOT).config;
	if (await exists(path)) return false;
	await fs.writeFile(path, `${JSON.stringify(configFor(ROOT), null, 2)}\n`, 'utf8');
	return true;
}

function runNpm(): Promise<{ code: number; log: string }> {
	const paths = lspPaths(ROOT);
	const args = ['ci', '--legacy-peer-deps'];
	return new Promise((resolve) => {
		let log = '';
		const child = spawn('npm', args, { cwd: paths.tree, stdio: ['ignore', 'pipe', 'pipe'] });
		const collect = (chunk: Buffer): void => {
			log = `${log}${String(chunk)}`.slice(-8000);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			log += `\n[timeout after ${TIMEOUT_MS}ms]`;
		}, TIMEOUT_MS);
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ code: 127, log: `${log}\nspawn failed: ${String(error)}` });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, log });
		});
	});
}

/**
 * Reconcile the tree with the pins. Safe to call more than once: the second call finds nothing to
 * do. Returns a one-line fact for the caller to show.
 */
async function reconcile(ctx: ExtensionContext | null, options: { force?: boolean } = {}): Promise<string> {
	if (disabled() && !options.force) return 'lsp-bootstrap: skipped (PI_LSP_AUTOINSTALL is off)';
	if (!hasPins(ROOT)) return 'lsp-bootstrap: no pins at lsp/package.json — nothing to install';

	const missing = drift(ROOT);
	const wroteConfig = await ensureConfig();
	if (!missing || !Object.keys(missing).length) {
		return wroteConfig
			? `lsp-bootstrap: servers already match the pins; wrote ${lspPaths(ROOT).config} (it was missing) — restart pi to pick it up`
			: 'lsp-bootstrap: servers match the pins';
	}

	const summary = Object.entries(missing)
		.map(([name, pair]) => `${name} ${pair.have ?? '(missing)'} → ${pair.want}`)
		.join(', ');
	if (!(await takeLock())) return `lsp-bootstrap: another process is installing (${summary})`;

	try {
		const { code, log } = await runNpm();
		await fs.mkdir(join(ROOT, 'logs'), { recursive: true }).catch(() => undefined);
		await fs.appendFile(LOG, `\n=== ${new Date().toISOString()} npm ci (${summary}) exit ${code} ===\n${log}\n`).catch(() => undefined);
		const after = drift(ROOT);
		if (code !== 0 || (after && Object.keys(after).length)) {
			ctx?.ui.notify(`Language servers could not be installed (${summary}); log: ${LOG}`, 'warning');
			return `lsp-bootstrap: install failed (${summary}) — see ${LOG}`;
		}
		ctx?.ui.notify(`Language servers installed (${summary}) — /reload or restart pi so the LSP client picks them up`, 'info');
		return `lsp-bootstrap: installed ${summary}`;
	} finally {
		await releaseLock();
	}
}

export default function lspBootstrap(pi: ExtensionAPI) {
	let attempted = false;

	// Background, after the session exists so a notification has somewhere to land.
	pi.on('session_start', async (_event, ctx) => {
		if (attempted) return;
		attempted = true;
		void reconcile(ctx).catch((error: unknown) => {
			ctx.ui.notify(`lsp-bootstrap: ${String(error)}`, 'warning');
		});
	});

}

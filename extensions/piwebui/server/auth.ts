/**
 * Provider credentials (`<agentDir>/auth.json`).
 *
 * Rules kept here:
 *  - secret values are **never** returned to the browser — only the provider id and the kind of
 *    credential that exists,
 *  - writes preserve every other entry, go through tmp+rename, keep a `.bak`, and force mode 600,
 *  - only API-key credentials can be set from the web UI; OAuth entries need the terminal's
 *    `/login <provider>` (we cannot run an interactive OAuth flow).
 */
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProviderAuth {
	provider: string;
	/** "api_key" when the entry carries a key, "oauth" when it carries tokens. */
	kind: "api_key" | "oauth" | "unknown";
	/** True when a usable secret is present (its value is never sent anywhere). */
	hasSecret: boolean;
	/** OAuth expiry, when the entry records one. */
	expires?: number;
}

export interface AuthSnapshot {
	file: string;
	exists: boolean;
	providers: ProviderAuth[];
	note: string;
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const SECRET_NOTE = "credential values are never read out to the browser";

function authPath(agentDir: string): string {
	return join(agentDir, "auth.json");
}

async function readAuth(agentDir: string): Promise<Record<string, Record<string, unknown>> | string> {
	try {
		const raw = await readFile(authPath(agentDir), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "refused: auth.json is not a JSON object";
		return parsed as Record<string, Record<string, unknown>>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return `refused: auth.json could not be read (${String(error)})`;
	}
}

function describe(entry: unknown): ProviderAuth["kind"] {
	if (!entry || typeof entry !== "object") return "unknown";
	const record = entry as Record<string, unknown>;
	if (typeof record.access === "string" || typeof record.refresh === "string") return "oauth";
	if (typeof record.key === "string" || typeof record.apiKey === "string") return "api_key";
	return "unknown";
}

export async function listAuth(agentDir: string): Promise<AuthSnapshot> {
	const file = authPath(agentDir);
	const exists = await stat(file).then(() => true).catch(() => false);
	const parsed = await readAuth(agentDir);
	if (typeof parsed === "string") {
		return { file, exists, providers: [], note: `${parsed} — ${SECRET_NOTE}` };
	}
	const providers: ProviderAuth[] = Object.entries(parsed).map(([provider, entry]) => {
		const kind = describe(entry);
		const record = (entry ?? {}) as Record<string, unknown>;
		const hasSecret = typeof record.key === "string" || typeof record.apiKey === "string" || typeof record.access === "string";
		const expires = typeof record.expires === "number" ? record.expires : undefined;
		return { provider, kind, hasSecret, expires };
	});
	providers.sort((a, b) => a.provider.localeCompare(b.provider));
	return { file, exists, providers, note: SECRET_NOTE };
}

export interface AuthWriteResult {
	ok: boolean;
	verbatim: string;
	backupPath: string | null;
}

async function writeAuth(agentDir: string, next: Record<string, unknown>): Promise<AuthWriteResult> {
	const file = authPath(agentDir);
	const previous = await readFile(file, "utf8").catch(() => null);
	if (previous !== null) await writeFile(`${file}.bak`, previous, { encoding: "utf8", mode: 0o600 });
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tmp, file);
	await writeFile(file, await readFile(file), { mode: 0o600 }).catch(() => undefined);
	return {
		ok: true,
		verbatim: `updated ${file}`,
		backupPath: previous !== null ? `${file}.bak` : null,
	};
}

/** Set (or rotate) an API key for one provider. The key is written, never echoed back. */
export async function setApiKey(agentDir: string, provider: string, key: string): Promise<AuthWriteResult> {
	if (!PROVIDER_PATTERN.test(provider)) return { ok: false, verbatim: `refused: "${provider}" is not a provider id`, backupPath: null };
	if (!key.trim()) return { ok: false, verbatim: "refused: empty key", backupPath: null };
	const parsed = await readAuth(agentDir);
	if (typeof parsed === "string") return { ok: false, verbatim: parsed, backupPath: null };
	const existing = parsed[provider];
	if (existing && describe(existing) === "oauth") {
		return { ok: false, verbatim: `refused: ${provider} uses an OAuth credential — run /login ${provider} in the terminal to replace it`, backupPath: null };
	}
	const next = { ...parsed, [provider]: { ...(existing ?? {}), type: "api_key", key } };
	return writeAuth(agentDir, next);
}

/** Remove a provider's stored credential. Needs an explicit confirmation flag. */
export async function removeProvider(agentDir: string, provider: string, confirmed: boolean): Promise<AuthWriteResult> {
	if (!confirmed) return { ok: false, verbatim: "refused: removing a credential needs confirmed:true", backupPath: null };
	const parsed = await readAuth(agentDir);
	if (typeof parsed === "string") return { ok: false, verbatim: parsed, backupPath: null };
	if (!(provider in parsed)) return { ok: false, verbatim: `refused: no stored credential for ${provider}`, backupPath: null };
	const next = { ...parsed };
	delete next[provider];
	return writeAuth(agentDir, next);
}

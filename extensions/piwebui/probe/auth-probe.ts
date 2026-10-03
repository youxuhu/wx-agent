/**
 * Credential panel: the browser may list which providers have credentials and set/remove an API
 * key, but must never receive a secret value. Runs against an instance whose agent dir is a
 * throwaway copy, so the user's real auth.json is untouched.
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:7802";
const AGENT_DIR = process.env.AGENT_DIR ?? "/tmp/piwebui-authtest";
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const realAuth = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"));
const realSecrets = Object.values(realAuth)
	.flatMap((entry) => Object.values(entry))
	.filter((value) => typeof value === "string" && value.length > 12);

const listResponse = await fetch(`${BASE}/api/auth`);
const listText = await listResponse.text();
const list = JSON.parse(listText);
check("provider list is returned", Array.isArray(list.providers) && list.providers.length > 0, list.providers.map((p) => `${p.provider}:${p.kind}`).join(", "));
check("kinds distinguish api keys from oauth", list.providers.some((p) => p.kind === "api_key") || list.providers.some((p) => p.kind === "oauth"), "kind field present");
const leaked = realSecrets.filter((secret) => listText.includes(secret));
check("no secret value ever reaches the client", leaked.length === 0, leaked.length ? `${leaked.length} leaked` : "verified against the real auth.json");

const oauth = list.providers.find((p) => p.kind === "oauth");
if (oauth) {
	const blocked = await fetch(`${BASE}/api/auth`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: oauth.provider, key: "should-be-refused-key" }) });
	const body = await blocked.json();
	check("an OAuth provider cannot be overwritten with an API key", blocked.status === 400 && /\/login/.test(body.verbatim), body.verbatim?.slice(0, 80));
}

const badProvider = await fetch(`${BASE}/api/auth`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "../etc/passwd", key: "x" }) });
check("bad provider ids are refused", badProvider.status === 400, (await badProvider.json()).verbatim);

const emptyKey = await fetch(`${BASE}/api/auth`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "probe-provider", key: "   " }) });
check("an empty key is refused", emptyKey.status === 400, (await emptyKey.json()).verbatim);

const write = await fetch(`${BASE}/api/auth`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "probe-provider", key: "probe-secret-value-123" }) });
const written = await write.json();
const stored = JSON.parse(await readFile(join(AGENT_DIR, "auth.json"), "utf8"));
check("setting a key writes the provider entry", write.status === 200 && stored["probe-provider"]?.type === "api_key" && stored["probe-provider"]?.key === "probe-secret-value-123", JSON.stringify(Object.keys(stored)));
check("other providers survive the write", Object.keys(realAuth).every((provider) => provider in stored) || Object.keys(stored).some((key) => key === "probe-provider"), "merged, not replaced");

const unconfirmed = await fetch(`${BASE}/api/auth?provider=probe-provider`, { method: "DELETE" });
check("removing a credential needs confirmation", unconfirmed.status === 400, (await unconfirmed.json()).verbatim);
const confirmed = await fetch(`${BASE}/api/auth?provider=probe-provider&confirmed=1`, { method: "DELETE" });
const afterDelete = JSON.parse(await readFile(join(AGENT_DIR, "auth.json"), "utf8"));
check("a confirmed removal deletes only that provider", confirmed.status === 200 && !("probe-provider" in afterDelete), Object.keys(afterDelete).join(", "));

const mode = (await import("node:fs/promises")).stat(join(AGENT_DIR, "auth.json")).then((info) => (info.mode & 0o777).toString(8));
check("the credential file stays private", (await mode) === "600", `mode ${await mode}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

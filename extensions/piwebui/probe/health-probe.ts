/** Health indicator mapping: quiet when healthy, specific when not. */
import { healthOf } from "../web/src/health.ts";

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const base = { conn: "open", piState: "running", exitInfo: null, reconnectIn: null };

const ok = healthOf(base);
check("healthy state stays quiet and green", ok.class === "health-ok" && ok.label === "connected", `${ok.class} "${ok.label}"`);

const connecting = healthOf({ ...base, conn: "connecting" });
check("connecting is announced", connecting.class === "health-warn" && /connecting/.test(connecting.label), connecting.label);

const closed = healthOf({ ...base, conn: "closed", reconnectIn: 4 });
check("a closed socket names itself and the retry delay", closed.class === "health-bad" && closed.label === "service closed — retrying in 4s", closed.label);

const errored = healthOf({ ...base, conn: "error" });
check("a socket error is reported without a retry hint", errored.class === "health-bad" && errored.label === "service error", errored.label);

const exited = healthOf({ ...base, piState: "exited", exitInfo: { code: 1, signal: null, at: "12:00:00" } });
check("a pi child exit shows its code", exited.class === "health-bad" && exited.label === "pi exited (1)", exited.label);

const signalled = healthOf({ ...base, piState: "exited", exitInfo: { code: null, signal: "SIGKILL", at: "12:00:00" } });
check("a signalled exit shows no code", signalled.class === "health-bad" && signalled.label === "pi exited", signalled.label);

const stopped = healthOf({ ...base, piState: "stopped" });
check("a stopped child is a warning, not an error", stopped.class === "health-warn" && stopped.label === "pi stopped", stopped.label);

const socketWins = healthOf({ ...base, conn: "closed", piState: "exited", exitInfo: { code: 3, signal: null, at: "x" }, reconnectIn: null });
check("the socket problem is reported before the child problem", socketWins.label === "service closed", socketWins.label);

check("every state carries a tooltip", [ok, connecting, closed, errored, exited, stopped].every((health) => health.title.length > 10), "titles present");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

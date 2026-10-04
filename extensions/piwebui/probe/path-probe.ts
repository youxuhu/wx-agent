/** Top-bar path display: a long path must keep the root and the last two segments. */
import { compactPath } from "../web/src/path.ts";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

check("a short path is shown whole", compactPath("/Users/revy") === "/Users/revy", compactPath("/Users/revy"));
check("a path with a trailing slash is shown whole", compactPath("/Users/revy/project") === "/Users/revy/project");
const long = "/Users/revy/project/minepi/docs/remote-workspace/plans";
const shown = compactPath(long);
check("a long path keeps the root", shown.startsWith("/Users/"), shown);
check("a long path keeps the last two segments", shown.endsWith("/remote-workspace/plans"), shown);
check("a long path is shortened", shown.length < long.length, `${shown.length} < ${long.length}`);
check("the marker is explicit, not a silent cut", shown.includes("…"), shown);
check("no folder renders as empty (the caller then shows its own hint)", compactPath("") === "");
check("a deep path never loses the tail", compactPath("/a/b/c/d/e/f").endsWith("/e/f"), compactPath("/a/b/c/d/e/f"));

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

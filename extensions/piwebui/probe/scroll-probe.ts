/**
 * Conversation scrolling follows the TUI: output stays pinned to the newest line only while the
 * reader is at the bottom. Scrolling up must not yank the viewport; coming back resumes following.
 */
import { isAtBottom, STICK_SLACK_PX } from "../web/src/scroll.ts";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const view = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({ scrollTop, scrollHeight, clientHeight });

check("exactly at the bottom follows", isAtBottom(view(900, 1400, 500)) === true);
check("a trackpad that stops a few pixels short still follows", isAtBottom(view(876, 1400, 500)) === true, `slack=${STICK_SLACK_PX}`);
check("scrolled up one full screen does not follow", isAtBottom(view(0, 1400, 500)) === false);
check("just past the slack stops following", isAtBottom(view(875, 1400, 500)) === false);
check("content shorter than the viewport is trivially at the bottom", isAtBottom(view(0, 300, 500)) === true);
check("an empty thread is at the bottom", isAtBottom(view(0, 0, 500)) === true);
check("a broken measurement does not throw and does not fight the reader", isAtBottom(view(0, Number.NaN, 500)) === true);
check("the slack is explicit, not magic", STICK_SLACK_PX === 24, String(STICK_SLACK_PX));

const hidden = results.filter((r) => r.name.includes("scrolled up") || r.name.includes("just past"));
check("scrolling up is recognised in both phrasings", hidden.every((r) => r.ok));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
	for (const f of failed) console.log(`  FAILED: ${f.name}`);
	process.exit(1);
}

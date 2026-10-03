/**
 * adapters/linux-wl.ts — Phase 2 stub (PLAN §5.3: ydotool input + grim screenshot, a11y=false).
 * Returns an unsupported adapter.
 */
import { unsupportedAdapter } from "../platform";

export function createAdapter() {
	return unsupportedAdapter(
		"linux-wayland",
		"Wayland backend (ydotool input + grim screenshot; no a11y tree) arrives in Phase 2.",
		"Phase 2",
	);
}

/**
 * adapters/linux-x11.ts — Phase 2 stub (PLAN §5.3: nut.js + AT-SPI pyatspi snippet).
 * Returns an unsupported adapter; capabilities report what the future backend will provide.
 */
import { unsupportedAdapter } from "../platform";

export function createAdapter() {
	return unsupportedAdapter(
		"linux-x11",
		"X11 backend (nut.js input + pyatspi a11y via `python3 -c`) arrives in Phase 2.",
		"Phase 2",
	);
}

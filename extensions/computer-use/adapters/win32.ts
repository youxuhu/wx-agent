/**
 * adapters/win32.ts — Phase 2 stub (PLAN §5.2: nut.js + UIA PowerShell Add-Type snippet).
 * Returns an unsupported adapter.
 */
import { unsupportedAdapter } from "../platform";

export function createAdapter() {
	return unsupportedAdapter(
		"win32",
		"Windows backend (nut.js input + UIA PowerShell snippet) arrives in Phase 2.",
		"Phase 2",
	);
}

/**
 * adapters/wsl.ts — Phase 3 stub (PLAN §5.4: powershell.exe interop, CopyFromScreen + SendInput).
 * Returns an unsupported adapter.
 */
import { unsupportedAdapter } from "../platform";

export function createAdapter() {
	return unsupportedAdapter(
		"wsl",
		"WSL interop (powershell.exe CopyFromScreen/SendInput) arrives in Phase 3.",
		"Phase 3",
	);
}

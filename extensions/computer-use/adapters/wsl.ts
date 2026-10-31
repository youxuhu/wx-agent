/** WSL adapter using the Windows desktop via powershell.exe interop. */
import { createWindowsAdapter } from "./windows";

export function createAdapter() {
	return createWindowsAdapter("wsl");
}

/** Native Windows adapter using the same PowerShell desktop backend as WSL. */
import { createWindowsAdapter } from "./windows";

export function createAdapter() {
	return createWindowsAdapter("win32");
}

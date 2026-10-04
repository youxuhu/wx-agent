/**
 * How a workspace path is shown in the top bar.
 *
 * The top bar is narrow, so a long path is shortened *in the middle*: the root and the last two
 * segments stay, because that is what tells two folders apart. The full path is always available
 * in the element's tooltip and in the sidebar footer.
 */
export function compactPath(path: string, maxLength = 40): string {
	if (!path) return "";
	if (path.length <= maxLength) return path;
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 3) return path;
	const [head] = parts as [string, ...string[]];
	const tail = parts.slice(-2).join("/");
	return `/${head}/…/${tail}`;
}

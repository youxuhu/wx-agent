/**
 * Conversation scroll rules, kept pure so they can be tested without a browser.
 *
 * A terminal follows output only while the view is pinned to the bottom. Once a reader scrolls
 * up, new output grows below the fold instead of yanking the viewport — the reader decides when
 * to come back (`End`, or the "jump to latest" control). Same rule here.
 */

/** How close to the bottom still counts as "at the bottom" (trackpads rarely land exactly). */
export const STICK_SLACK_PX = 24;

export interface ScrollMetrics {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

/** True when the viewport is at the bottom, so new output should keep following. */
export function isAtBottom(metrics: ScrollMetrics, slack: number = STICK_SLACK_PX): boolean {
	const { scrollTop, scrollHeight, clientHeight } = metrics;
	if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return true;
	// Nothing to scroll (content fits): staying "at the bottom" is trivially true.
	if (scrollHeight <= clientHeight) return true;
	return scrollHeight - scrollTop - clientHeight <= slack;
}

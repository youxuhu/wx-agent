/**
 * The topbar health line: the browser↔service socket and the pi child process folded into one
 * statement. Healthy states stay quiet; anything else names the problem.
 */
export interface HealthInput {
	conn: "connecting" | "open" | "closed" | "error";
	piState: string;
	exitInfo: { code: number | null; signal: string | null; at: string } | null;
	reconnectIn: number | null;
}

export interface Health {
	class: "health-ok" | "health-warn" | "health-bad";
	label: string;
	title: string;
}

export function healthOf(input: HealthInput): Health {
	const { conn, piState, exitInfo, reconnectIn } = input;
	if (conn === "connecting") {
		return { class: "health-warn", label: "connecting…", title: "connecting to the local service" };
	}
	if (conn !== "open") {
		const retry = reconnectIn ? ` — retrying in ${reconnectIn}s` : "";
		return {
			class: "health-bad",
			label: `service ${conn}${retry}`,
			title: "the local service socket is down; nothing can be sent until it is back",
		};
	}
	if (exitInfo) {
		return {
			class: "health-bad",
			label: `pi exited${exitInfo.code !== null ? ` (${exitInfo.code})` : ""}`,
			title: `pi child exited at ${exitInfo.at}${exitInfo.signal ? ` (signal ${exitInfo.signal})` : ""}`,
		};
	}
	if (piState !== "running") {
		return { class: "health-warn", label: `pi ${piState || "unknown"}`, title: "the pi rpc child is not running" };
	}
	return { class: "health-ok", label: "connected", title: `service socket open · pi child ${piState}` };
}

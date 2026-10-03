/**
 * controller.ts — deterministic progress controller (PLAN §6).
 * Hard rules the model cannot bypass: precheck() rejections become tool isError results.
 * English messages are aimed at the model (PLAN §10).
 */

export interface ActionRecord {
	seq: number;
	action: string;
	target: string; // "element:3" | "x,y" | action name for non-targeting actions
	at: number;
	stateHash: string;
	ok: boolean;
}

export interface TaskBudgets {
	maxActions: number; // default 60
	maxStall: number; // consecutive no-change actions, default 3
}

const RING_SIZE = 200;

export class ProgressController {
	private records: ActionRecord[] = [];
	private seq = 0;
	private totalActions = 0;
	private budgets: TaskBudgets;

	constructor(budgets?: Partial<TaskBudgets>) {
		this.budgets = { maxActions: budgets?.maxActions ?? 60, maxStall: budgets?.maxStall ?? 3 };
	}

	/** Reset per-turn state (stall counter + repeat detection) but keep totalActions. */
	onTurnEnd(): void {
		this.records = [];
	}

	getStats(): { totalActions: number; maxActions: number; recent: ActionRecord[] } {
		return { totalActions: this.totalActions, maxActions: this.budgets.maxActions, recent: [...this.records] };
	}

	precheck(action: string): { ok: true } | { ok: false; reason: string } {
		if (this.totalActions >= this.budgets.maxActions) {
			return { ok: false, reason: "Action budget exhausted (maxActions). You must stop and report to the user." };
		}
		const recent = this.records.slice(-6);
		const same = recent.filter((r) => r.action === action);
		if (same.length >= 3) {
			return { ok: false, reason: "Detected a repeating action loop (same action >=3 times in the last 6 steps). Change approach and report." };
		}
		if (this.records.length >= this.budgets.maxStall) {
			const tail = this.records.slice(-this.budgets.maxStall);
			const allSame = tail.every((r) => r.ok && r.stateHash !== "" && r.stateHash === tail[0].stateHash);
			if (allSame) {
				return { ok: false, reason: `No screen change for ${this.budgets.maxStall} consecutive actions. You must not repeat the same action; stop and report or change strategy.` };
			}
		}
		return { ok: true };
	}

	record(r: Omit<ActionRecord, "seq" | "at">): ActionRecord {
		this.seq += 1;
		this.totalActions += 1;
		const rec: ActionRecord = { seq: this.seq, at: Date.now(), ...r };
		this.records.push(rec);
		if (this.records.length > RING_SIZE) this.records.shift();
		return rec;
	}
}

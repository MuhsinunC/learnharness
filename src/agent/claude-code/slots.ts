const key = Symbol.for("lh.claudeCode.slots");
type Ticket = { grant(): void; dead: boolean };
const state = globalThis as typeof globalThis & { [key]?: { active: number; queue: Ticket[] } };
export function resetClaudeCodeSlotsForTests(): void { delete state[key]; }

export async function acquireClaudeCodeSlot(signal?: AbortSignal): Promise<() => void> {
	const pool = state[key] ??= { active: 0, queue: [] };
	const value = Number(process.env.LH_CLAUDE_CODE_MAX_CHILDREN ?? 4);
	const cap = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 4;
	const aborted = () => new Error("aborted");
	if (signal?.aborted) throw aborted();
	if (pool.active < cap && !pool.queue.length) pool.active++;
	else await new Promise<void>((resolve, reject) => {
		const die = () => { ticket.dead = true; signal?.removeEventListener("abort", die); reject(aborted()); };
		const ticket: Ticket = { dead: false, grant: () => { signal?.removeEventListener("abort", die); resolve(); } };
		pool.queue.push(ticket);
		signal?.addEventListener("abort", die, { once: true });
	});
	let released = false;
	return () => {
		if (released) return;
		released = true;
		// A handed-off permit stays counted; only fresh takers increment active.
		for (;;) {
			const next = pool.queue.shift();
			if (!next) { pool.active--; return; }
			if (!next.dead) { next.grant(); return; }
		}
	};
}

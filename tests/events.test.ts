/**
 * THE EVENT BUS (push-architecture slice 1, 2026-10-02): pure core law
 * (typed, globalThis-shared, error-isolated). These pins are its
 * contract: every future consumer (chat view, sidebar, dock) builds on
 * exactly this. The SSE seam's pins run against the real server in
 * tests/e2e/events-stream.e2e.ts (LH-54).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emit, subscribe, type ServerEvent } from "../src/core/events.ts";

// ─── the bus ────────────────────────────────────────────────────────────────

describe("event bus", () => {
	it("delivers typed events with their payload to every subscriber", () => {
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		emit("turn-started", { chatId: "chat_a" });
		emit("jobs-changed", { chatId: "chat_a" });
		emit("activity-changed", {});
		off();
		assert.deepEqual(got, [
			{ type: "turn-started", chatId: "chat_a" },
			{ type: "jobs-changed", chatId: "chat_a" },
			{ type: "activity-changed" },
		]);
	});

	it("unsubscribe stops delivery, exactly once", () => {
		let calls = 0;
		const off = subscribe(() => calls++);
		emit("chats-changed", {});
		off();
		emit("chats-changed", {});
		assert.equal(calls, 1);
	});

	it("one listener throwing NEVER breaks the others (error isolation)", () => {
		const got: string[] = [];
		subscribe(() => {
			throw new Error("listener bug");
		});
		const off = subscribe((e) => got.push(e.type));
		emit("turn-settled", { chatId: "chat_b" });
		off();
		assert.deepEqual(got, ["turn-settled"]);
	});

	it("emit with zero subscribers is a silent no-op", () => {
		assert.doesNotThrow(() => emit("chats-changed", {}));
	});

	it("the registry is globalThis-backed — the Next multi-entry law (turn-liveness discipline)", () => {
		// Every module instance must share ONE bus or nothing propagates
		// (the original incident: page render vs route each held a private
		// singleton). The key IS the contract.
		const g = globalThis as { __lhEventBus?: unknown };
		assert.ok(g.__lhEventBus instanceof Set, "the bus lives on globalThis");
	});

	it("an unsubscribe DURING emit is safe (snapshot iteration)", () => {
		const got: string[] = [];
		let off2: () => void = () => {};
		const off1 = subscribe(() => off2()); // listener 2 leaves mid-emit
		off2 = subscribe((e) => got.push(e.type));
		emit("chats-changed", {});
		off1();
		off2();
		assert.deepEqual(got, ["chats-changed"], "listener 2 still got THIS event (snapshot), no crash");
	});
});

/**
 * The failed-turn retry (issue #110): a model call that fails persists as an
 * assistant message with stopReason "error". The learner's input survives
 * (write-ahead), but pre-fix nothing could re-run the turn — re-answering
 * 400'd (the question is no longer dangling) and `continue` died in pi
 * ("Cannot continue from message role: assistant"). The `retry` input drops
 * the failure and re-runs the turn from the input that preceded it.
 *
 * Drives handleChatRequest with a scripted pi engine (the chat-flow pattern).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { SessionModel } from "../components/session-core.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { ChatInputError, endsInFailedTurn, parseChatInput, retryDrops } from "../src/core/input-events.ts";
import { newPlanBlockMessage, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

/** A response step that fails the way a dropped connection does. */
const networkFailure = (() => {
	throw new Error("fetch failed");
}) as unknown as FauxResponseStep;

/** Scripted engine; each step records the conversation roles it saw
 *  (the composed system message aside). */
function scripted(steps: FauxResponseStep[]): { engine: PiEngine; contexts: string[][] } {
	const contexts: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => ((context: { messages: Array<{ role: string }> }, ...rest: unknown[]) => {
			contexts.push(context.messages.map((m) => m.role).filter((r) => r !== "system"));
			return (step as (...a: unknown[]) => unknown)(context, ...rest);
		}) as unknown as FauxResponseStep),
	);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, contexts };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

/** POST one input event; on a 200 ack, drain the turn to completion. */
async function turn(engine: PiEngine, chatId: string, input: unknown): Promise<Response> {
	const ack = await handleChatRequest(post(chatId, input), (opts) =>
		createTeacherAgent(undefined, { engine, messages: opts.messages }),
	);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

function gradedAnswer() {
	const options = normalizeOptions(QUIZ_INPUT.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: QUIZ_INPUT.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(QUIZ_INPUT.correctAnswer, options).indices,
		explanation: QUIZ_INPUT.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values: ["Mercury"] });
}

const roles = (chatId: string) => chatStore.getChat(chatId)!.messages.map((m) => m.role);

describe("failed-turn retry (issue #110)", () => {
	it("a failed answer turn re-runs from the saved answer — no re-answering needed", async () => {
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })], { stopReason: "toolUse" }),
			networkFailure,
			() => fauxAssistantMessage([fauxText("Right — Mercury it is.")]),
		]);
		const chat = createConfiguredChat("Test: retry after failed answer");

		await turn(engine, chat.id, { type: "text", text: "teach me the planets" });
		await turn(engine, chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer() });

		// The failure as #110 met it: answer durable, turn failed, and the
		// pre-fix paths refused.
		assert.deepEqual(roles(chat.id), ["user", "assistant", "toolResult", "assistant"]);
		assert.ok(endsInFailedTurn(chatStore.getChat(chat.id)!.messages));
		const reanswer = await turn(engine, chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer() });
		assert.equal(reanswer.status, 400, "the answered question cannot be answered again");

		const retry = await turn(engine, chat.id, { type: "retry" });
		assert.equal(retry.status, 200);

		const saved = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(saved.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(endsInFailedTurn(saved), false, "the failure left the record");
		assert.match(JSON.stringify(saved.at(-1)), /Mercury it is/);
		assert.deepEqual(contexts.at(-1), ["user", "assistant", "toolResult"], "the retried call saw the answer, not the failure");
	});

	it("a failed text turn re-runs from the learner's message", async () => {
		const { engine, contexts } = scripted([networkFailure, () => fauxAssistantMessage([fauxText("Hello again.")])]);
		const chat = createConfiguredChat("Test: retry after failed text");

		await turn(engine, chat.id, { type: "text", text: "hello" });
		assert.deepEqual(roles(chat.id), ["user", "assistant"]);
		assert.ok(endsInFailedTurn(chatStore.getChat(chat.id)!.messages));

		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 200);
		assert.deepEqual(roles(chat.id), ["user", "assistant"]);
		assert.match(JSON.stringify(chatStore.getChat(chat.id)!.messages.at(-1)), /Hello again/);
		assert.deepEqual(contexts.at(-1), ["user"]);
	});

	it("refuses a retry with nothing failed — 400, record untouched", async () => {
		const { engine } = scripted([() => fauxAssistantMessage([fauxText("Fine.")])]);
		const chat = createConfiguredChat("Test: retry refused");

		await turn(engine, chat.id, { type: "text", text: "hello" });
		const before = chatStore.getChat(chat.id)!.messages;
		const res = await turn(engine, chat.id, { type: "retry" });
		assert.equal(res.status, 400);
		assert.match(await res.text(), /requires a failed turn/);
		assert.deepEqual(chatStore.getChat(chat.id)!.messages, before);
	});

	it("a plan block persisted after the failure stays, and the turn still retries", async () => {
		const { engine, contexts } = scripted([networkFailure, () => fauxAssistantMessage([fauxText("Planned reply.")])]);
		const chat = createConfiguredChat("Test: retry past a plan block");

		await turn(engine, chat.id, { type: "text", text: "hello" });
		// persistTurn's shape when plan_init succeeded and the next call
		// failed: the plan block lands AFTER the failure.
		const failedRecord = chatStore.getChat(chat.id)!.messages;
		chatStore.saveMessages(chat.id, [...failedRecord, newPlanBlockMessage("plan-1", {})]);
		assert.ok(endsInFailedTurn(chatStore.getChat(chat.id)!.messages), "the failure is still found past the marker");

		assert.equal((await turn(engine, chat.id, { type: "retry" })).status, 200);
		const saved = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(saved.map((m) => m.role), ["user", "custom", "assistant"], "failure dropped, plan block kept");
		assert.match(JSON.stringify(saved.at(-1)), /Planned reply/);
		assert.deepEqual(contexts.at(-1), ["user"], "the plan block is not model input");
	});
});

describe("the Retry button's client path", () => {
	it("after a dropped request, Retry posts straight from the error status", async () => {
		const failedTurn = [
			{ ...newUserMessage("hello"), id: "u1" },
			{ ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }), id: "a1" },
		] as unknown as LhMessage[];
		const posted: string[] = [];
		let online = false;
		const fetch = (async (_url: string, init?: RequestInit) => {
			if (!online) throw new TypeError("Failed to fetch");
			if (init?.method === "POST") posted.push(String(init.body));
			return new Response("{}", { status: 500 }); // the reattach is not under test
		}) as typeof globalThis.fetch;
		const m = new SessionModel({ chatId: "chat_x", initialMessages: failedTurn, fetch });

		await m.send({ type: "retry" });
		assert.equal(m.getState().status, "error", "the dropped request leaves the model in error");
		online = true;
		await m.send({ type: "retry" });
		assert.equal(posted.length, 1, "send() recovers from error without stop()");
		assert.deepEqual(JSON.parse(posted[0]!).input, { type: "retry" });
	});
});

describe("retryDrops (pure)", () => {
	const failed = (id: string): LhMessage =>
		({ ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }), id }) as unknown as LhMessage;

	it("parses the retry input event", () => {
		assert.deepEqual(parseChatInput({ type: "retry" }), { type: "retry" });
	});

	it("drops every trailing failure back to the input", () => {
		const user = { ...newUserMessage("hi"), id: "u1" } as LhMessage;
		assert.deepEqual([...retryDrops([user, failed("a1"), failed("a2")])].sort(), ["a1", "a2"]);
	});

	it("looks past trailing UI-only markers, and keeps them", () => {
		const user = { ...newUserMessage("hi"), id: "u1" } as LhMessage;
		const block = newPlanBlockMessage("plan-1", {});
		assert.deepEqual([...retryDrops([user, failed("a1"), block])], ["a1"]);
		assert.equal(endsInFailedTurn([user, block]), false, "a marker alone is no failure");
		const compaction = newCompactionMarker("summary", { firstKeptMessageId: "u1", tokensBefore: 100, model: "fixture", at: "2026-01-01T00:00:00Z" });
		assert.deepEqual([...retryDrops([user, failed("a1"), compaction])], ["a1"], "the settle kick's marker too");
	});

	it("throws when the record does not end in a failure, or nothing precedes it", () => {
		const user = { ...newUserMessage("hi"), id: "u1" } as LhMessage;
		assert.throws(() => retryDrops([user]), ChatInputError);
		assert.throws(() => retryDrops([failed("a1")]), ChatInputError);
	});
});

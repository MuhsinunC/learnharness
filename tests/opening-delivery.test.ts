import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { newUserMessage } from "../src/core/native-messages.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

describe("new-session opening delivery acceptance", () => {
	it("notifies acceptance before the record read or teacher stream completes", async () => {
		const record = deferred<Response>();
		const accepted = deferred<void>();
		const calls: string[] = [];
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			calls.push(String(url));
			if (String(url) === "/api/chat") return Response.json({ ok: true });
			if (String(url).endsWith("/stream")) return new Response("data: [DONE]\n\n");
			return record.promise;
		} });
		let completed = false;
		const sending = m.send({ type: "text", text: "my syllabus" }, () => accepted.resolve()).then(result => { completed = true; return result; });
		await accepted.promise;
		assert.equal(completed, false);
		assert.equal(m.getState().hasConfirmedConversation, false, "optimistic user text is not canonical proof");
		record.resolve(Response.json({ messages: [newUserMessage("my syllabus")] }));
		assert.equal(await sending, true);
		assert.equal(m.getState().hasConfirmedConversation, true);
		assert.equal(calls.filter(url => url === "/api/chat").length, 1);
	});

	it("a teardown racing the POST still cleans up on acknowledgment without attaching", async () => {
		const post = deferred<Response>();
		let notified = 0;
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			assert.equal(String(url), "/api/chat");
			return post.promise;
		} });
		const sending = m.send({ type: "text", text: "hello" }, () => { notified++; });
		m.stop();
		post.resolve(Response.json({ ok: true }));
		assert.equal(await sending, true);
		assert.equal(notified, 1);
	});

	for (const failure of ["refusal", "409", "lost acknowledgment"] as const) {
		it(`${failure} does not notify acceptance or leave a false confirmed conversation`, async () => {
			let notified = false;
			const m = new SessionModel({ chatId: "c1", initialMessages: [], waitMaxMs: 0, fetch: async () => {
				if (failure === "lost acknowledgment") throw new TypeError("connection lost");
				return new Response("refused", { status: failure === "409" ? 409 : 503 });
			} });
			assert.equal(await m.send({ type: "text", text: "keep this" }, () => { notified = true; }), false);
			assert.equal(notified, false);
			assert.equal(m.getState().hasConfirmedConversation, false);
			assert.equal(m.getState().nativeMessages.length, 0, "restore the opening draft, not a stranded optimistic bubble");
			assert.equal(m.status, "error");
		});
	}

	it("post-acceptance attachment failure remains accepted and does not resend input", async () => {
		let posts = 0;
		let notified = 0;
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async url => {
			if (String(url) === "/api/chat") { posts++; return Response.json({ ok: true }); }
			throw new TypeError("record read failed");
		} });
		assert.equal(await m.send({ type: "text", text: "hello" }, () => { notified++; }), true);
		assert.equal(notified, 1);
		assert.equal(posts, 1);
		assert.equal(m.status, "error");
	});

	it("a busy gate sends nothing, then canonical adoption can confirm an earlier lost acknowledgment", async () => {
		const m = new SessionModel({ chatId: "c1", initialMessages: [], fetch: async () => { throw new Error("must not post"); } });
		m.readyRef = false;
		assert.equal(await m.send({ type: "text", text: "hello" }, () => assert.fail("must not acknowledge")), false);
		m.setMessages([newUserMessage("hello")]);
		assert.equal(m.getState().hasConfirmedConversation, true);
	});
});

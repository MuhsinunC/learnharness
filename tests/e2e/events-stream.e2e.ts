import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootServer, type LhServer } from "./harness/server.ts";

// The window event channel, /api/events, read by plain clients against
// the real server (LH-54 moved these pins here from tests/events.test.ts).
// It is text/event-stream with no caching, no transform and no proxy
// buffering; it sends an `: open` comment at once, before any event, so a
// window's EventSource opens (and resyncs) on connect rather than on its
// first event; it carries each server event as one named frame; a client
// that goes away stops only its own stream; and no event ends a stream:
// the client owns its lifetime.

let server: LhServer;

before(async () => {
	server = await bootServer({ ticket: "lh-54", providers: [], settings: { version: 1, graph: { enabled: false } } });
});

after(async () => {
	await server?.stop();
});

/** One client of the channel: its response and the text it has read so far. */
async function connect() {
	const res = await server.api("/api/events");
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	/** Read until `want` matches the text so far (10 s at most). */
	const readUntil = async (want: RegExp): Promise<string> => {
		const deadline = Date.now() + 10_000;
		while (!want.test(text)) {
			const left = deadline - Date.now();
			assert.ok(left > 0, `timed out waiting for ${want} (read ${JSON.stringify(text)})`);
			const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
			if (chunk === null) continue;
			assert.equal(chunk.done, false, `the stream ended while waiting for ${want} (read ${JSON.stringify(text)})`);
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text;
	};
	return { res, reader, readUntil, read: () => text };
}

/** A server event every open window hears: a new chat's chats-changed. */
const newChat = (title: string) => server.json("/api/chats", { body: { title } });

test("the channel opens at once with ': open', then carries each event as one named frame", async () => {
	const client = await connect();
	try {
		assert.equal(client.res.status, 200);
		assert.equal(client.res.headers.get("Content-Type"), "text/event-stream");
		assert.equal(client.res.headers.get("Cache-Control"), "no-cache, no-transform");
		assert.equal(client.res.headers.get("X-Accel-Buffering"), "no");
		assert.equal(await client.readUntil(/\n\n/), ": open\n\n", "the stream opens before any event");
		await newChat("An event");
		const text = await client.readUntil(/event: chats-changed\n/);
		assert.ok(text.startsWith(": open\n\n"));
		assert.match(text, /(^|\n\n)event: chats-changed\ndata: \{\}\n\n/, "one parseable frame: the type on the event line, the payload on the data line");
	} finally {
		await client.reader.cancel();
	}
});

test("a client that goes away stops only its own stream; no event ends another's", async () => {
	const first = await connect();
	const second = await connect();
	try {
		await first.readUntil(/: open\n\n/);
		await second.readUntil(/: open\n\n/);
		await first.reader.cancel();
		await newChat("After one window left");
		await second.readUntil(/event: chats-changed\n/);
		const done = await first.reader.read();
		assert.equal(done.done, true, "the cancelled stream carries nothing further");
		// The channel has no [DONE]: after an event it stays open for the next.
		await newChat("And another");
		const text = await second.readUntil(/(event: chats-changed\n[^]*){2}/);
		assert.ok(!text.includes("[DONE]"), "no end-of-stream sentinel");
	} finally {
		await second.reader.cancel();
	}
});

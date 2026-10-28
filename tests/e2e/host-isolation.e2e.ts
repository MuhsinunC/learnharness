import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootServer, type LhServer } from "./harness/server.ts";

// The harness hides the host from the server (LH-51): with its own HOME and
// a PATH cut to the system dirs, the Providers tab sees no Claude Code
// install and no signed-in account, even on a machine where one exists.

let server: LhServer;

before(async () => {
	server = await bootServer({ ticket: "lh-51", providers: [], settings: { version: 1, graph: { enabled: false } } });
});

after(async () => {
	await server?.stop();
});

test("the Claude Code status finds no executable and no account", async () => {
	const status = await server.json<Record<string, unknown>>("/api/claude-code");
	assert.deepEqual(status.candidates, []);
	assert.equal(status.executable, null);
	assert.equal(status.discovered, null);
	assert.equal(status.found, false);
	assert.equal(status.loggedIn, false);
	assert.equal(status.account, null);
});

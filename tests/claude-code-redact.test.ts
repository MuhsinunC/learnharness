import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/agent/claude-code/redact.ts";

test("redacts every raw, URL-encoded and JSON-escaped token and URL userinfo occurrence", () => {
	const token = 'secret/"\\value';
	const userinfo = "user:password";
	const endpoint = { baseUrl: `https://${userinfo}@relay.example`, token };
	const variants = [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1), userinfo, encodeURIComponent(userinfo)];
	assert.equal(redactSecrets(variants.concat(variants).join(" | "), endpoint), variants.concat(variants).map(() => "[redacted]").join(" | "));
	assert.equal(redactSecrets("https://user:p%40ss@relay.example user:p@ss", { ...endpoint, baseUrl: "https://user:p%40ss@relay.example" }), "https://[redacted]@relay.example [redacted]");
	assert.equal(redactSecrets(token, null), token);
	assert.equal(redactSecrets(token, undefined), token);
});

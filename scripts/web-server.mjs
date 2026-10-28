#!/usr/bin/env node
/**
 * Web-mode launcher and bind gate (LH-43): `npm run dev` and `npm start`.
 * Always listens on 127.0.0.1 (LH_LISTEN_PORT, else PORT, else 3000), and
 * refuses any other address and any -H/-p in the passed-through options.
 * To reach it from a phone, use `npm start` plus `tailscale serve`
 * (docs/remote-access.md). Remote access never works with `dev`: Next's
 * dev-only endpoints skip the login gate. LH_DATA_DIR is pinned so the
 * proxy and the routes read one login record.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [mode, ...extra] = process.argv.slice(2);

function refuse(message) {
	console.error(`LearnHarness will not start: ${message}\nSee docs/remote-access.md.`);
	process.exit(78);
}

if (mode !== "dev" && mode !== "start") {
	console.error("usage: node scripts/web-server.mjs dev|start [next options]");
	process.exit(64);
}
const host = process.env.LH_LISTEN_HOST;
if (host !== undefined && host !== "127.0.0.1") {
	refuse(`LH_LISTEN_HOST=${host}: LearnHarness only listens on 127.0.0.1. For your phone, use tailscale serve.`);
}
// -H, --hostname, -p, --port in any spelling (-H0.0.0.0, --port=80, ...).
const bind = extra.find((arg) => /^(-[Hp]|--(hostname|port)(=|$))/.test(arg));
if (bind) refuse(`${bind}: the address and port are set by LearnHarness (use LH_LISTEN_PORT for the port).`);

const port = process.env.LH_LISTEN_PORT || process.env.PORT || "3000";
const child = spawn(path.join(ROOT, "node_modules", ".bin", "next"), [mode, "-H", "127.0.0.1", "-p", port, ...extra], {
	cwd: ROOT,
	stdio: "inherit",
	env: { ...process.env, LH_DATA_DIR: path.resolve(process.env.LH_DATA_DIR || path.join(ROOT, "data")) },
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

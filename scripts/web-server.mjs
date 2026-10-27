#!/usr/bin/env node
/**
 * Web-mode launcher and bind gate (LH-43): `npm run dev` and `npm start`.
 *
 *   LH_LISTEN_HOST  default 127.0.0.1. Another address is allowed only once
 *                   a login password is set (Settings → General → Remote
 *                   access), and only a Tailscale address (100.64.0.0/10,
 *                   fd7a:115c:a1e0::/48). 0.0.0.0 or :: also need
 *                   LH_LISTEN_ALL=1. Hostnames and other addresses are refused.
 *   LH_LISTEN_PORT  default PORT, else 3000.
 *
 * The recommended setup keeps the default and runs `tailscale serve`
 * (docs/remote-access.md). LH_LISTEN_HOST is exported to the server, where
 * proxy.ts uses it to decide whether loopback requests can be trusted, and
 * LH_DATA_DIR is pinned so the proxy and the routes read one login record.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
	console.error("usage: node scripts/web-server.mjs dev|start [next options]");
	process.exit(64);
}
const host = (process.env.LH_LISTEN_HOST || "127.0.0.1").trim();
const port = process.env.LH_LISTEN_PORT || process.env.PORT || "3000";
const dataDir = path.resolve(process.env.LH_DATA_DIR || path.join(ROOT, "data"));

function refuse(message) {
	console.error(`LearnHarness will not start: ${message}\nSee docs/remote-access.md.`);
	process.exit(78);
}

/** Same check as passwordConfigured() in src/server/web-login.ts. */
function passwordSet() {
	try {
		return typeof JSON.parse(fs.readFileSync(path.join(dataDir, "web-login.json"), "utf8"))?.password?.hash === "string";
	} catch {
		return false;
	}
}

function kind(address) {
	if (address === "localhost" || address === "::1" || /^127(\.\d{1,3}){3}$/.test(address)) return "loopback";
	if (address === "0.0.0.0" || address === "::") return "all";
	if (net.isIPv4(address)) {
		const [a, b] = address.split(".").map(Number);
		return a === 100 && b >= 64 && b <= 127 ? "tailscale" : "other";
	}
	if (net.isIPv6(address)) return /^fd7a:115c:a1e0:/i.test(address) ? "tailscale" : "other";
	return "name";
}

const k = kind(host);
if (k === "name") refuse(`LH_LISTEN_HOST=${host} is not an IP address. Use 127.0.0.1 or this computer's Tailscale IP (tailscale ip -4).`);
if (k === "other") refuse(`LH_LISTEN_HOST=${host} is not a loopback or Tailscale address. LearnHarness never listens on a LAN or public interface.`);
if (k === "all" && process.env.LH_LISTEN_ALL !== "1") refuse(`LH_LISTEN_HOST=${host} listens on every interface, including your Wi-Fi. Set LH_LISTEN_ALL=1 only if you really mean that.`);
if (k !== "loopback" && !passwordSet()) refuse(`listening on ${host} needs a login password first. Start it on 127.0.0.1, open Settings → General → Remote access, and set one.`);

const next = path.join(ROOT, "node_modules", ".bin", "next");
const child = spawn(next, [mode, "-H", host, "-p", port, ...process.argv.slice(3)], {
	cwd: ROOT,
	stdio: "inherit",
	env: { ...process.env, LH_LISTEN_HOST: host, LH_DATA_DIR: dataDir },
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

/**
 * Remote access from the terminal (LH-43, docs/remote-access.md): set the
 * login password, or turn remote access off, without a browser. Being able
 * to write this computer's data folder is the proof that you are on it, so
 * this is how web mode sets its first password (never over plain HTTP).
 *
 *   npm run remote-access:set-password    asks twice, input hidden
 *   npm run remote-access:off             removes the password and every session
 *
 * The data folder is LH_DATA_DIR, else the repo's data/ (what `npm start`
 * uses). `set-password --stdin` reads one line from a pipe instead of the
 * terminal, for scripts.
 */
import { remotePasswordProblem } from "../src/core/remote-access.ts";
import { clearPassword, setPassword } from "../src/server/web-login.ts";

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

/** One line from the terminal with echo off. */
function ask(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		const input = process.stdin;
		process.stdout.write(prompt);
		input.setRawMode(true);
		input.resume();
		let value = "";
		const onData = (chunk: Buffer) => {
			for (const ch of chunk.toString("utf8")) {
				if (ch === "\u0003") {
					process.stdout.write("\n");
					process.exit(130);
				} else if (ch === "\r" || ch === "\n") {
					input.setRawMode(false);
					input.pause();
					input.off("data", onData);
					process.stdout.write("\n");
					resolve(value);
					return;
				} else if (ch === "\u007f" || ch === "\b") {
					value = [...value].slice(0, -1).join("");
				} else {
					value += ch;
				}
			}
		};
		input.on("data", onData);
	});
}

async function fromPipe(): Promise<string> {
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return text.split(/\r?\n/)[0] ?? "";
}

const [command, flag] = process.argv.slice(2);
if (command === "set-password") {
	let password: string;
	if (flag === "--stdin") {
		password = await fromPipe();
	} else {
		if (!process.stdin.isTTY) fail("Run this in a terminal, or pass --stdin to read the password from a pipe.");
		password = await ask("New remote-access password: ");
		if ((await ask("Type it again: ")) !== password) fail("The two passwords differ. Nothing changed.");
	}
	const problem = remotePasswordProblem(password);
	if (problem) fail(`${problem} Nothing changed.`);
	await setPassword(password);
	console.log("Remote access is on. Every device that was logged in must log in again.");
	console.log("Next: start LearnHarness with `npm start`, then run `tailscale serve --bg <port>` (docs/remote-access.md).");
} else if (command === "off") {
	clearPassword();
	console.log("Remote access is off. If you used tailscale serve, also run: tailscale serve --https=443 off");
} else {
	fail("usage: tsx scripts/remote-access.ts set-password [--stdin] | off");
}

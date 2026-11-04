import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * Headless system Chrome for driving the UI, with its own throwaway
 * --user-data-dir (never the owner's profile). CHROME_PATH overrides the
 * binary; otherwise the standard macOS install, else puppeteer's "chrome"
 * channel lookup.
 */

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface HeadlessChrome {
	browser: Browser;
	close(): Promise<void>;
}

/** `args` are appended to the defaults, e.g. a --host-resolver-rules map. */
export async function launchChrome(ticket: string, args: string[] = []): Promise<HeadlessChrome> {
	const base = path.join(os.homedir(), ".cache", "lh-e2e", ticket);
	fs.mkdirSync(base, { recursive: true });
	const userDataDir = fs.mkdtempSync(path.join(base, "chrome-"));
	const executablePath = process.env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
	const browser = await puppeteer.launch({
		headless: true,
		userDataDir,
		...(executablePath ? { executablePath } : { channel: "chrome" as const }),
		args: ["--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", ...args],
	});
	return {
		browser,
		close: async () => {
			await browser.close().catch(() => {});
			fs.rmSync(userDataDir, { recursive: true, force: true });
		},
	};
}

/** Wait until React has hydrated `selector` (its props are on the element):
 * a click, paste or key sent to server-rendered markup before that has no
 * listener. Keyed on React's internal `__reactProps` key, so only here. */
export async function hydrated(page: Page, selector: string, timeout = 180_000): Promise<void> {
	await page.waitForFunction(
		(sel) => {
			const el = document.querySelector(sel);
			return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
		},
		{ timeout },
		selector,
	);
}

/** The page's EventSource behind a switch (window.lhChannel): drop()
 *  closes the connection as a sleep or a network blip does, so what the
 *  server sends meanwhile never arrives; reopen() connects again, which
 *  fires the page's own open handler. A script, not a function: tsx
 *  would wrap a nested class in its __name helper, which the page lacks. */
export const DROPPABLE_CHANNEL = `(() => {
	const Native = window.EventSource;
	window.EventSource = function (url, init) {
		const listeners = [];
		const channel = { onopen: null };
		const connect = () => {
			const es = new Native(url, init);
			es.onopen = (ev) => channel.onopen && channel.onopen(ev);
			for (const [name, cb] of listeners) es.addEventListener(name, cb);
			return es;
		};
		let es = connect();
		channel.addEventListener = (name, cb) => { listeners.push([name, cb]); es.addEventListener(name, cb); };
		channel.close = () => es.close();
		channel.drop = () => es.close();
		channel.reopen = () => { es = connect(); };
		window.lhChannel = channel;
		return channel;
	};
})();`;

export type ChannelWindow = { lhChannel: { drop(): void; reopen(): void } };

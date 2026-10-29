import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

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

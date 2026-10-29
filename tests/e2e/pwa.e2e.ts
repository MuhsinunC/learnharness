import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseHTML } from "linkedom";
import { bootServer, type LhServer } from "./harness/server.ts";
import { launchChrome } from "./harness/chrome.ts";

// LH-46: the site installs to a phone's home screen. The home page links a
// web app manifest and an apple-touch-icon and carries the iOS meta; the
// manifest names the app, opens it standalone at "/" in the dark palette,
// and every icon it lists (and the touch icon) is a PNG of its stated size.
// All of it is fetched WITHOUT a session (no cookies), the way iOS fetches
// the manifest and touch icon and the way a manifest fetch omits
// credentials, so the paths it prints are the ones a login wall must pass.
// Chrome at phone size parses the manifest without errors and reports no
// installability errors.

const TICKET = "lh-46";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let server: LhServer;

before(async () => {
	server = await bootServer({ ticket: TICKET, providers: [], settings: { version: 1, graph: { enabled: false } } });
});

after(async () => {
	await server?.stop();
});

const get = (href: string) => fetch(new URL(href, server.url), { credentials: "omit" });

/** Width and height from the PNG's IHDR chunk (big-endian, bytes 16-23). */
function pngSize(bytes: Buffer): string {
	assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", "a PNG signature");
	return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

async function assertPng(href: string, sizes: string): Promise<void> {
	const res = await get(href);
	assert.equal(res.status, 200, href);
	assert.equal(res.headers.get("content-type"), "image/png", href);
	assert.equal(pngSize(Buffer.from(await res.arrayBuffer())), sizes, href);
}

test("the manifest, the touch icon and the iOS meta load without a session", async (t) => {
	const res = await get("/");
	assert.equal(res.status, 200);
	const { document } = parseHTML(await res.text());
	const meta = (name: string) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content");
	assert.equal(meta("apple-mobile-web-app-capable"), "yes");
	assert.equal(meta("apple-mobile-web-app-title"), "LearnHarness");
	assert.equal(meta("apple-mobile-web-app-status-bar-style"), "black");
	assert.equal(meta("theme-color"), "#141414");

	const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
	assert.ok(manifestHref, "a manifest link");
	const touch = document.querySelector('link[rel="apple-touch-icon"]');
	assert.ok(touch, "an apple-touch-icon link");
	assert.equal(touch.getAttribute("sizes"), "180x180");
	const touchHref = touch.getAttribute("href")!;

	const manifestRes = await get(manifestHref);
	assert.equal(manifestRes.status, 200);
	assert.match(manifestRes.headers.get("content-type") ?? "", /^application\/manifest\+json/);
	const manifest = (await manifestRes.json()) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> };
	assert.equal(manifest.name, "LearnHarness");
	assert.equal(manifest.short_name, "LearnHarness");
	assert.equal(manifest.start_url, "/");
	assert.equal(manifest.scope, "/");
	assert.equal(manifest.display, "standalone");
	assert.equal(manifest.theme_color, "#141414");
	assert.equal(manifest.background_color, "#141414");
	assert.deepEqual(
		manifest.icons.map((i) => `${i.sizes} ${i.purpose ?? "any"}`),
		["192x192 any", "512x512 any", "512x512 maskable"],
	);

	for (const icon of manifest.icons) {
		assert.equal(icon.type, "image/png");
		await assertPng(icon.src, icon.sizes);
	}
	await assertPng(touchHref, "180x180");

	const paths = [manifestHref, ...manifest.icons.map((i) => i.src), touchHref].map((href) => new URL(href, server.url).pathname);
	t.diagnostic(`fetched without a session: ${paths.join(" ")}`);
});

test("Chrome at phone size reads the manifest and reports no installability errors", async () => {
	const chrome = await launchChrome(TICKET);
	try {
		const page = await chrome.browser.newPage();
		await page.setViewport(PHONE);
		await page.goto(server.url, { waitUntil: "load", timeout: 180_000 });
		await page.waitForSelector('[aria-label="Open sidebar"]', { visible: true, timeout: 60_000 });
		const width = await page.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth }));
		assert.equal(width.innerWidth, PHONE.width);
		assert.ok(width.scrollWidth <= PHONE.width, `the page is wider than the screen: ${JSON.stringify(width)}`);

		const cdp = await page.createCDPSession();
		const app = (await cdp.send("Page.getAppManifest")) as { url: string; errors: unknown[]; data?: string };
		assert.match(app.url, /\/manifest\.webmanifest$/);
		assert.deepEqual(app.errors, []);
		assert.ok(app.data, "Chrome fetched the manifest");
		const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: Array<{ errorId: string }> };
		assert.deepEqual(installabilityErrors.map((e) => e.errorId), []);
	} finally {
		await chrome.close();
	}
});

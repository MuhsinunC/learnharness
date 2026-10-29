import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import type { ElementHandle, Page } from "puppeteer-core";
import { bootServer, until, type LhServer } from "./harness/server.ts";
import { launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { calledTool, lastToolName, reply, startStubProvider, type StubProvider, type StubRequest } from "./harness/stub-provider.ts";

// LH-44: the pages the desktop app renders fit a phone (390×844, touch),
// a tablet (768×1024, touch) and a desktop window (1280×800). On every
// surface (home and graph, the sessions drawer, the new-session composer,
// a chat with a demo and a figure, the composer with an image chip, the
// question dock, Settings tab by tab, the context-window modal, the
// session menu and the delete dialog, the chain table, the popovers) the
// page never scrolls sideways, no control sits outside the viewport, and
// the key controls are on screen and on top. On touch the drawer opens and closes by tap, every input is at
// least 16px (iOS zooms the page on focus below that), and the key tap
// targets are at least 40px. Screenshots land outside the repo for review.

const TICKET = "lh-44";
const SHOTS = process.env.LH_E2E_SHOTS ?? path.join(os.homedir(), ".cache", "lh-e2e", TICKET, "shots", "after");
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface Viewport {
	name: string;
	width: number;
	height: number;
	deviceScaleFactor: number;
	isMobile: boolean;
	hasTouch: boolean;
	ua?: string;
}
const PHONE: Viewport = { name: "phone", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, ua: IPHONE_UA };
const TABLET: Viewport = { name: "tablet", width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ua: IPAD_UA };
const DESKTOP: Viewport = { name: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

// A teacher reply that is hard to fit: a wide table, an unbroken URL, a
// long code line, display math and a mermaid chart.
const RICH = [
	"## Limits, continuity and a wide table",
	"A limit is the value a function approaches. A long unbroken token: https://example.com/a/very/long/path/that/never/breaks/anywhere/because/it/is/one/word",
	"",
	"| x | f(x) = x² | g(x) = sin(x)/x | h(x) = (1+1/x)^x | difference | ratio | notes |",
	"|---|---|---|---|---|---|---|",
	"| 0.1 | 0.01 | 0.99833 | 2.5937 | 0.00012 | 1.0001 | approaching from the right |",
	"| 0.01 | 0.0001 | 0.99998 | 2.7048 | 0.0000012 | 1.000001 | closer still |",
	"",
	"```python",
	"def limit(f, a, h=1e-9): return (f(a + h) + f(a - h)) / 2  # a long line of code that runs past the column edge",
	"```",
	"",
	"$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1 \\quad\\text{and}\\quad \\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e \\approx 2.718281828459045$$",
	"",
	"```mermaid",
	"flowchart LR",
	"  A[Sequence] --> B[Limit] --> C[Continuity] --> D[Derivative] --> E[Integral]",
	"```",
].join("\n");
const ASSESSMENT = { assessment: { strands: [{ strand: "limits", assessment: "Knows the idea." }] } };
const DEMO_HTML = "<!doctype html><html><body><input type=range id=s><output id=o>0</output><script>s.oninput=()=>o.textContent=s.value</script></body></html>";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="none" stroke="black"/></svg>';
const QUIZ_MARKER = "[quiz-me]";
const PROBE = {
	question: "A signal is $y=\\sin(2x)$ and $\\frac{dx}{dt}=3$. What is $\\frac{dy}{dt}$?",
	options: [
		{ label: "$6\\cos(2x)$", value: "a" },
		{ label: "$2\\cos(2x)$", value: "b" },
		{ label: "$3\\cos(2x)$", value: "c" },
	],
	explanation: "Multiply by the inner slopes: $\\cos(2x)\\cdot2\\cdot3$.",
	correctAnswer: "a",
};

function respond(req: StubRequest) {
	const transcript = JSON.stringify(req.messages);
	if (req.system.includes("You are a demo builder")) {
		const last = lastToolName(req);
		if (!last) return reply.tools([{ name: "write_demo", arguments: { html: DEMO_HTML } }]);
		if (last === "write_demo") return reply.tools([{ name: "run_demo", arguments: {} }]);
		return reply.text("A slider whose value is echoed beside it.");
	}
	if (req.system.includes("You are a visual maker"))
		return calledTool(req, "write_svg") ? reply.text("A circle.") : reply.tools([{ name: "write_svg", arguments: { svg: SVG } }]);
	// The quiz session stays in the probe: its open question owns the dock.
	if (transcript.includes(QUIZ_MARKER)) return calledTool(req, "probe") ? reply.text("Take your time.") : reply.tools([{ name: "probe", arguments: PROBE }]);
	if (req.tools.includes("probe_done") && !calledTool(req, "probe_done")) return reply.tools([{ name: "probe_done", arguments: ASSESSMENT }]);
	if (req.tools.includes("demo") && !calledTool(req, "demo"))
		return reply.tools([
			{ name: "demo", arguments: { title: "Limit slider", brief: "One slider, value shown." } },
			{ name: "visual", arguments: { brief: "A circle centred in the frame." } },
		], "Let me build a demo and draw it.");
	return reply.text(RICH);
}

/** A solid-color PNG, for the composer's image chip. */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
		return out;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([200, 40, 40], 1 + x * 3);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const NAMES = ["Limit", "Continuity", "Derivative", "Integral", "Sequence", "Epsilon-delta", "Squeeze theorem", "Mean value theorem"];
const NODES = NAMES.map((name, i) => ({ id: `n_lh44_${i}`, name, statement: `${name} is a core idea of calculus.`, aliases: [], createdAt: "2026-10-27T00:00:00.000Z", provenance: [] }));
const CHAINS = [[0, 1], [1, 2], [2, 3], [4, 0], [5, 0], [6, 0], [2, 7]].map(([p, c], i) => ({
	id: `arg_lh44_${i}`, premises: [`n_lh44_${p}`], conclusion: `n_lh44_${c}`, provenance: [], createdAt: "2026-10-27T00:00:00.000Z",
}));

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;
/** The lesson with a demo, a figure and rich replies; the probe with an open question. */
let lessonId: string;
let quizId: string;

async function settled(id: string): Promise<boolean> {
	return !(await server.json<{ turnInFlight: boolean }>(`/api/chats/${id}`)).turnInFlight;
}

before(async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	stub = await startStubProvider(respond);
	const slot = { model: { provider: "e2e-stub", id: "stub-a" } };
	server = await bootServer({
		ticket: TICKET,
		providers: [{ id: "e2e-stub", baseUrl: stub.baseUrl, models: [{ id: "stub-a", input: ["text", "image"], contextWindow: 100_000 }] }],
		settings: { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } },
	});
	const graph = path.join(server.dataDir, "graph");
	fs.mkdirSync(graph, { recursive: true });
	fs.writeFileSync(path.join(graph, "nodes.jsonl"), NODES.map((n) => `${JSON.stringify(n)}\n`).join(""));
	fs.writeFileSync(path.join(graph, "chains.jsonl"), CHAINS.map((c) => `${JSON.stringify(c)}\n`).join(""));

	({ id: lessonId } = await server.json<{ id: string }>("/api/chats", { body: { title: "Limits and continuity, from sequences to the derivative" } }));
	({ id: quizId } = await server.json<{ id: string }>("/api/chats", { body: { title: "Chain rule check" } }));
	for (const [id, text] of [[lessonId, "Teach me limits."], [quizId, `Quiz me on the chain rule. ${QUIZ_MARKER}`]] as const) {
		const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text } } });
		assert.equal(res.status, 200, await res.clone().text());
		await res.arrayBuffer();
	}
	// Both jobs delivered into the lesson, and every turn settled.
	await until(async () => {
		const { jobs } = await server.json<{ jobs: Array<{ id: string; status: string }> }>(`/api/jobs?chatId=${lessonId}`);
		const { messages } = await server.json<{ messages: Array<{ id?: string }> }>(`/api/chats/${lessonId}`);
		return jobs.length === 2 && jobs.every((j) => j.status === "done" && messages.some((m) => m.id === `steer_${j.id}`));
	}, "the demo and the figure to reach the lesson", 240_000, 1000);
	await until(async () => (await settled(lessonId)) && (await settled(quizId)), "every turn to settle", 120_000);
	chrome = await launchChrome(TICKET);
});

after(async () => {
	await chrome?.close();
	await server?.stop();
	await stub?.close();
});

/** One viewport's walk: a page, the problems found so far, and the checks. */
class Walk {
	problems: string[] = [];
	constructor(readonly page: Page, readonly vp: Viewport) {}

	get touch(): boolean {
		return this.vp.hasTouch;
	}

	async goto(pathname: string): Promise<void> {
		await this.page.goto(server.url + pathname, { waitUntil: "domcontentloaded", timeout: 180_000 });
		// Hydrated: React's handlers are on the sidebar's search input.
		await this.page.waitForFunction(
			() => Object.keys(document.querySelector("[data-testid=session-search]") ?? {}).some((k) => k.startsWith("__reactProps")),
			{ timeout: 180_000 },
		);
	}

	async el(selector: string): Promise<ElementHandle<Element>> {
		const el = await this.page.waitForSelector(selector, { visible: true, timeout: 60_000 });
		assert.ok(el, `${this.vp.name}: ${selector} is on the page`);
		return el;
	}

	/** Tap on touch viewports, click on the desktop one. */
	async press(selector: string): Promise<void> {
		const el = await this.el(selector);
		if (this.touch) await el.tap();
		else await el.click();
	}

	async settle(ms = 600): Promise<void> {
		await new Promise((r) => setTimeout(r, ms));
	}

	/** The surface's checks, then its screenshot. `controls` must be visible and wholly on screen. */
	async check(surface: string, controls: string[], opts: { minTap?: string[] } = {}): Promise<void> {
		const at = `${this.vp.name} ${surface}`;
		// A mobile browser widens its layout viewport to fit wide content (and
		// zooms out), so innerWidth itself is checked against the device width.
		const page = await this.page.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth }));
		if (page.innerWidth !== this.vp.width || page.scrollWidth > this.vp.width) {
			this.problems.push(`${at}: the page is wider than the screen (scrollWidth ${page.scrollWidth}, innerWidth ${page.innerWidth}, screen ${this.vp.width})`);
		}
		// Every visible interactive element is inside the screen's width,
		// unless it sits in a horizontal scroller (a wide table, a tab strip).
		const offscreen = await this.page.evaluate((width) => {
			const out: string[] = [];
			for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=file]), textarea, select, [role=button]")) {
				if (el.closest("[aria-hidden=true], [inert]")) continue;
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.pointerEvents === "none") continue;
				let scroller = false;
				for (let p = el.parentElement; p && !scroller; p = p.parentElement) scroller = /auto|scroll/.test(getComputedStyle(p).overflowX);
				if (scroller) continue;
				if (r.left < -1 || r.right > width + 1) {
					const name = el.dataset.testid ?? el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40);
					out.push(`${el.tagName.toLowerCase()} "${name}" spans x ${Math.round(r.left)}..${Math.round(r.right)}`);
				}
			}
			return out;
		}, this.vp.width);
		for (const o of offscreen) this.problems.push(`${at}: ${o} (viewport ${this.vp.width})`);
		for (const selector of controls) {
			const el = await this.page.$(selector);
			const box = el && (await el.isVisible()) ? await el.boundingBox() : null;
			if (!el || !box) {
				this.problems.push(`${at}: ${selector} is not visible`);
				continue;
			}
			const inside = box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= this.vp.width + 0.5 && box.y + box.height <= this.vp.height + 0.5;
			if (!inside) this.problems.push(`${at}: ${selector} is outside the viewport (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)})`);
			// Reachable: a tap at its center lands on it, not on something drawn over it.
			const onTop = await el.evaluate((node) => {
				if (getComputedStyle(node).pointerEvents === "none") return true;
				const r = node.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return !!hit && node.contains(hit);
			});
			if (!onTop) this.problems.push(`${at}: ${selector} is covered by another element`);
		}
		if (this.touch) {
			// iOS Safari zooms the page when a focused field's text is under 16px.
			const small = await this.page.evaluate(() =>
				[...document.querySelectorAll<HTMLElement>("input:not([type=checkbox], [type=radio], [type=range], [type=file]), textarea, select")]
					.filter((el) => el.getBoundingClientRect().width > 0 && !el.closest("[aria-hidden=true], [inert]") && parseFloat(getComputedStyle(el).fontSize) < 16)
					.map((el) => `${el.dataset.testid ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder")} (${getComputedStyle(el).fontSize})`),
			);
			for (const s of small) this.problems.push(`${at}: input ${s} is under 16px, so iOS zooms on focus`);
			for (const selector of opts.minTap ?? []) {
				for (const el of await this.page.$$(selector)) {
					const box = await el.boundingBox();
					if (box && (box.width < 40 || box.height < 40)) this.problems.push(`${at}: tap target ${selector} is ${Math.round(box.width)}×${Math.round(box.height)}, under 40px`);
				}
			}
		}
		await this.page.screenshot({ path: path.join(SHOTS, `${this.vp.name}-${surface}.png`) });
	}

	/** Open the sessions sidebar: the drawer on touch widths, inline on the desktop. */
	async openSidebar(): Promise<void> {
		if ((await this.page.$eval("[data-testid=sidebar]", (el) => el.getAttribute("aria-hidden"))) === "true") await this.press('[aria-label="Open sidebar"]');
		await until(async () => (await this.page.$eval("[data-testid=sidebar]", (el) => el.getAttribute("aria-hidden"))) === "false", `${this.vp.name}: the sidebar to open`, 10_000);
		await this.settle(400);
	}

	async drawerClosed(): Promise<boolean> {
		return this.page.$eval("[data-testid=sidebar]", (el) => el.getAttribute("aria-hidden") === "true" && el.getBoundingClientRect().right <= 0);
	}
}

async function walk(vp: Viewport): Promise<string[]> {
	const page = await chrome.browser.newPage();
	await page.setViewport(vp);
	if (vp.ua) await page.setUserAgent(vp.ua);
	const w = new Walk(page, vp);
	const compact = vp.width < 1024;
	try {
		// The viewport meta: device width, and cover so the safe-area insets are real on iOS.
		await w.goto("/");
		const meta = await page.$eval('meta[name="viewport"]', (el) => el.getAttribute("content") ?? "");
		assert.match(meta, /width=device-width/);
		assert.match(meta, /viewport-fit=cover/);

		// Home: the graph with its chrome, and the start composer.
		await page.waitForSelector("[data-testid=open-chain-table]", { timeout: 60_000 });
		await w.settle(1500);
		await w.check("home", ["[data-testid=open-chain-table]", "[data-testid=import-notes]", "[data-testid=graph-settings]", 'textarea[placeholder="What do you want to learn?"]', '[aria-label="Start session"]', "[data-testid=home-mode-practice]"], {
			minTap: ['[aria-label="Open sidebar"]', '[aria-label="Start session"]'],
		});
		await w.press("[data-testid=graph-settings]");
		await w.settle();
		await w.check("graph-settings", ["[data-testid=graph-settings-panel]"]);
		await w.press("[data-testid=graph-settings]");
		await w.press("[data-testid=open-chain-table]");
		await page.waitForSelector("[data-testid=chain-table]", { timeout: 30_000 });
		await w.settle();
		await w.check("chain-table", ["[data-testid=chain-table-search]", "[data-testid=chain-table-close]", "[data-testid=sort-name]"]);
		await w.press("[data-testid=chain-table-close]");

		// The sessions sidebar: a drawer below the desktop width.
		if (compact) {
			assert.ok(await w.drawerClosed(), `${vp.name}: the drawer starts closed`);
			await w.openSidebar();
			assert.ok(await page.$("[data-testid=sidebar-backdrop]"), `${vp.name}: the open drawer has a backdrop`);
			await w.check("drawer", ["[data-testid=new-session]", "[data-testid=session-search]", "[data-testid=settings-entry]", '[aria-label="Close sidebar"]', "[data-testid=session-row-menu]"], {
				minTap: ['[aria-label="Close sidebar"]', "[data-testid=session-row-menu]", "[data-testid=session-row]"],
			});
			// A tap on the backdrop, right of the drawer, closes it.
			const drawer = (await (await w.el("[data-testid=sidebar]")).boundingBox())!;
			await page.touchscreen.tap(Math.min(vp.width - 10, drawer.width + 30), vp.height / 2);
			await until(() => w.drawerClosed(), `${vp.name}: a backdrop tap to close the drawer`, 5000);
			// Opening a session from the drawer navigates and closes it.
			await w.openSidebar();
			await w.press(`[data-testid=session-row][data-chat-id="${lessonId}"]`);
			await page.waitForFunction((id) => location.pathname === `/chat/${id}`, { timeout: 60_000 }, lessonId);
			await until(() => w.drawerClosed(), `${vp.name}: navigation to close the drawer`, 5000);
			// "+ Teaching" leads to the new-session composer, and closes the drawer too.
			await w.openSidebar();
			await w.press("[data-testid=new-session]");
			await page.waitForFunction(() => location.pathname === "/chat/new", { timeout: 60_000 });
			await until(() => w.drawerClosed(), `${vp.name}: New session to close the drawer`, 5000);
		} else {
			// The desktop keeps the inline sidebar, open by default.
			const box = (await (await w.el("[data-testid=sidebar]")).boundingBox())!;
			assert.equal(Math.round(box.x), 0);
			assert.equal(Math.round(box.width), 288);
			assert.equal(await page.$("[data-testid=sidebar-backdrop]"), null, "no backdrop beside the inline sidebar");
			await w.check("sidebar", ["[data-testid=new-session]", "[data-testid=session-search]", "[data-testid=settings-entry]"]);
			await w.press("[data-testid=new-session]");
			await page.waitForFunction(() => location.pathname === "/chat/new", { timeout: 60_000 });
		}
		await page.waitForSelector("[data-testid=composer] textarea", { timeout: 60_000 });
		await w.settle(1000);
		await w.check("new-session", ["[data-testid=composer] textarea", "[data-testid=composer] button[type=submit]", "[data-testid=stats-model]"]);

		// The lesson: rich replies, the demo card, the figure card, the composer.
		await w.goto(`/chat/${lessonId}`);
		await page.waitForSelector("[data-testid=demo-card]", { timeout: 60_000 });
		await w.settle(1500);
		await w.check("chat", ["[data-testid=composer] textarea", "[data-testid=composer] button[type=submit]", "[data-testid=phase-chip]", "[data-testid=stats-model]", '[aria-label="Open sidebar"]'], {
			minTap: ["[data-testid=composer] button[type=submit]"],
		});
		for (const card of ["demo-card", "visual-card"]) {
			await page.$eval(`[data-testid=${card}]`, (el) => el.scrollIntoView({ block: "center" }));
			await w.settle();
			await w.check(card, [`[data-testid=${card}]`]);
		}
		await page.$eval("[data-testid=demo-card] iframe", (el) => el.scrollIntoView({ block: "center" }));
		await w.press("[data-testid=visual-open]");
		await w.settle();
		await w.check("figure-overlay", ['[data-testid="mermaid-overlay-close"]', '[aria-label="Zoom in"]']);
		await w.press('[data-testid="mermaid-overlay-close"]');

		// The composer with an image chip.
		await page.evaluate((b64) => {
			const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const dt = new DataTransfer();
			dt.items.add(new File([data], "my-working-for-the-limit-question.png", { type: "image/png" }));
			document.querySelector("[data-testid=composer] textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
		}, png(160, 90).toString("base64"));
		await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
		await page.type("[data-testid=composer] textarea", "Here is my working for the limit question, as a photo.");
		await w.settle(1000);
		await w.check("composer-image", ["[data-testid=attachment-chip]", "[data-testid=composer] textarea", "[data-testid=composer] button[type=submit]"]);

		// The popovers under the composer.
		await w.press("[data-testid=stats-summary]");
		await w.settle();
		await w.check("stats-popover", ["[data-testid=stats-detail]"]);
		await w.press("[data-testid=stats-summary]");
		await w.press("[data-testid=stats-model]");
		await w.settle();
		await w.check("model-picker", ["[data-testid=model-search]", "[data-testid=model-option-stub-a]"]);
		await page.keyboard.press("Escape");

		// The session menu: a "…" tap on touch, a right-click on the desktop; then the delete dialog.
		await w.openSidebar();
		const row = `[data-testid=session-row][data-chat-id="${quizId}"]`;
		if (w.touch) await w.press(`[data-testid=session-row-menu][data-chat-id="${quizId}"]`);
		else await (await w.el(row)).click({ button: "right" });
		await page.waitForSelector("[data-testid=session-context-menu]", { timeout: 10_000 });
		await w.settle();
		await w.check("session-menu", ["[data-testid=ctx-rename]", "[data-testid=ctx-export-md]", "[data-testid=ctx-delete]"]);
		await w.press("[data-testid=ctx-delete]");
		await w.settle();
		await w.check("delete-dialog", ["[data-testid=delete-cancel]", "[data-testid=delete-confirm]"]);
		await w.press("[data-testid=delete-cancel]");

		// The question dock of an open probe question.
		await w.goto(`/chat/${quizId}`);
		await page.waitForSelector("[data-testid=question-dock]", { timeout: 60_000 });
		await w.settle(1000);
		await w.check("question-dock", ["[data-testid=question-dock]", "[data-testid=confidence-slider]"]);

		// Settings, tab by tab, then the context-window modal.
		await w.openSidebar();
		await w.press("[data-testid=settings-entry]");
		await page.waitForSelector("[data-testid=settings-dialog]", { timeout: 30_000 });
		for (const tab of ["keys", "agent", "appearance", "graph", "keyboard", "general"]) {
			await w.press(`[data-testid=settings-nav-${tab}]`);
			await page.waitForSelector(`[data-testid=section-${tab}]`, { timeout: 30_000 });
			await w.settle(800);
			await w.check(`settings-${tab}`, ["[data-testid=settings-close]", `[data-testid=settings-nav-${tab}]`], {
				minTap: ["[data-testid=settings-close]", `[data-testid=settings-nav-${tab}]`],
			});
		}
		await w.press("[data-testid=settings-nav-agent]");
		const field = '[data-testid="context-window-row-e2e-stub:stub-a"] [data-testid="input-context-window"]';
		// A late load of the section remounts the field, and the modal (its
		// child) with it, so retry until the value holds and the modal stays.
		const openModal = async () => {
			await (await w.el(field)).scrollIntoView();
			await w.press(field);
			await page.$eval(field, (el) => (el as HTMLInputElement).select());
			await page.type(field, "150000");
			if ((await page.$eval(field, (el) => (el as HTMLInputElement).value)) !== "150000") return;
			await page.keyboard.press("Enter");
			await page.waitForSelector("[data-testid=context-window-dialog]", { timeout: 15_000 });
		};
		await until(async () => {
			if (!(await page.$("[data-testid=context-window-dialog]"))) await openModal();
			await w.settle(1000);
			return page.$("[data-testid=context-window-dialog]");
		}, `${vp.name}: the context-window modal`, 90_000, 500);
		await w.check("context-window-modal", ["[data-testid=context-window-understood]", "[data-testid=context-window-confirm]", "[data-testid=context-window-cancel]"]);
		await w.press("[data-testid=context-window-cancel]");
		await w.press("[data-testid=settings-close]");
		await until(async () => (await page.$("[data-testid=settings-dialog]")) === null, `${vp.name}: Settings to close`, 5000);
	} finally {
		await page.close();
	}
	return w.problems;
}

test("a phone (390×844, touch): every surface fits and every action is a tap away", async () => {
	assert.deepEqual(await walk(PHONE), []);
});

test("a tablet (768×1024, touch): every surface fits", async () => {
	assert.deepEqual(await walk(TABLET), []);
});

test("a desktop window (1280×800): every surface fits, the sidebar stays inline", async () => {
	assert.deepEqual(await walk(DESKTOP), []);
});

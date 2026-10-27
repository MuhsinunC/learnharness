import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { imageDimensions, MAX_ATTACHMENT_BYTES } from "../../src/core/attachments.ts";
import { bootServer, until, type BootOptions, type LhServer } from "./harness/server.ts";
import { launchChrome, type HeadlessChrome } from "./harness/chrome.ts";
import { calledTool, reply, startStubProvider, type StubProvider, type StubRequest } from "./harness/stub-provider.ts";

// LH-39: images attach by paste, drop and path; every one is copied into
// <data>/attachments; the copies outlive the originals and a restart; the
// request after compaction carries references only (view_image brings the
// pixels back); a model that can't read images says so in the composer.

const TICKET = "lh-39";
// ~85k chars ≈ 21k tokens: past the 20k kept-tail budget, so the cut lands
// on this message and the three earlier image messages are summarized.
const LONG = "Here is a long passage of notes about the topic. ".repeat(1_700);
const VIEW_AGAIN = "Please look at the first image again.";
const READ_ASK = "Please read the screenshot file.";

/** A valid PNG of one solid color (4×4 unless sized) — distinct bytes per color. */
function png(r: number, g: number, b: number, width = 4, height = 4): Buffer {
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
	for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A valid 24-bit BMP of one solid color: Chrome decodes it, the store refuses it. */
function bmp(r: number, g: number, b: number, width = 8, height = 8): Buffer {
	const rowSize = Math.ceil((width * 3) / 4) * 4;
	const out = Buffer.alloc(54 + rowSize * height);
	out.write("BM", 0, "latin1");
	out.writeUInt32LE(out.length, 2);
	out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14);
	out.writeInt32LE(width, 18);
	out.writeInt32LE(height, 22);
	out.writeUInt16LE(1, 26);
	out.writeUInt16LE(24, 28);
	out.writeUInt32LE(rowSize * height, 34);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set([b, g, r], 54 + y * rowSize + x * 3);
	return out;
}

const IMAGES = { pasted: png(220, 30, 30), dropped: png(30, 200, 40), byPath: png(30, 40, 210) };
const idOf = (bytes: Buffer) => `${createHash("sha256").update(bytes).digest("hex")}.png`;

/** Every base64 image payload a request carried, any format. */
function imagesIn(req: StubRequest): string[] {
	return [...JSON.stringify(req.messages).matchAll(/data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]!);
}
const lastUserText = (req: StubRequest) => JSON.stringify([...req.messages].reverse().find((m) => m.role === "user")?.content ?? "");
const isSummary = (req: StubRequest) => JSON.stringify(req.messages).includes("You are compacting");

let stub: StubProvider;
let server: LhServer;
let chrome: HeadlessChrome;
let originals: string;
let chatId: string;
/** The first boot's data dir, reused by the restart. */
let dataDir: string;
/** A PNG on disk the stub's teacher reads with the read tool. */
let readFile: string;
const READ_IMAGE = png(10, 160, 160);

const providers: BootOptions["providers"] = [];
const slot = { model: { provider: "e2e-stub", id: "vision-a" } };
const settings = { version: 1, models: { strong: slot, cheap: slot, vision: slot }, graph: { enabled: false } };

before(async () => {
	stub = await startStubProvider((req) => {
		// The summarizer: echo the image references it was given, the way a
		// faithful summary keeps identifiers exact.
		if (isSummary(req)) {
			const ids = [...new Set(JSON.stringify(req.messages).match(/[0-9a-f]{64}\.png/g) ?? [])];
			return reply.text(`## The learner's understanding\nShared images: ${ids.join(", ")}`);
		}
		if (lastUserText(req).includes(VIEW_AGAIN) && !calledTool(req, "view_image")) {
			return reply.tools([{ name: "view_image", arguments: { id: idOf(IMAGES.pasted) } }]);
		}
		if (lastUserText(req).includes(READ_ASK) && !calledTool(req, "read")) {
			return reply.tools([{ name: "read", arguments: { path: readFile } }]);
		}
		// The long message's reply reports a context past the 150k default
		// threshold, so compaction runs at settle (the post-compaction
		// projection, ~31k, stays under it).
		return reply.text("I see it.", lastUserText(req).length > 50_000 ? { promptTokens: 160_000 } : {});
	});
	providers.push({
		id: "e2e-stub",
		baseUrl: stub.baseUrl,
		models: [
			{ id: "vision-a", input: ["text", "image"] },
			{ id: "text-only", input: ["text"] },
			{ id: "plain-text", input: ["text"] },
		],
	});
	server = await bootServer({ ticket: TICKET, providers, settings });
	dataDir = server.dataDir;
	chrome = await launchChrome(TICKET);
	originals = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", TICKET, "originals-"));
	for (const [name, bytes] of Object.entries(IMAGES)) fs.writeFileSync(path.join(originals, `${name}.png`), bytes);
	readFile = path.join(path.dirname(dataDir), "read-me.png");
	fs.writeFileSync(readFile, READ_IMAGE);
});

after(async () => {
	await chrome?.close();
	await server?.stop();
	await stub?.close();
	if (originals) fs.rmSync(originals, { recursive: true, force: true });
	if (dataDir) fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
});

async function openChat(page: Page, id: string): Promise<void> {
	await page.goto(`${server.url}/chat/${id}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await page.waitForSelector("[data-testid=composer] textarea", { timeout: 180_000 });
	// Hydrated: React's handlers are on the textarea (a paste before this
	// lands on server-rendered markup with no listener).
	await page.waitForFunction(
		() => Object.keys(document.querySelector("[data-testid=composer] textarea")!).some((k) => k.startsWith("__reactProps")),
		{ timeout: 180_000 },
	);
	// The model control has reported the chat's model (the image gate keys on it).
	await until(async () => {
		const label = await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "").catch(() => "");
		return label.trim().length > 1 && label.trim() !== "—";
	}, "the model control to load", 120_000);
}

/** Fire a paste or drop of one image file on the composer, as the browser would. */
async function fileEvent(page: Page, kind: "paste" | "drop", bytes: Buffer, name: string, type = "image/png"): Promise<void> {
	await page.evaluate(
		(kind, b64, name, type) => {
			const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const dt = new DataTransfer();
			dt.items.add(new File([data], name, { type }));
			if (kind === "paste") {
				document.querySelector("[data-testid=composer] textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
			} else {
				const form = document.querySelector("[data-testid=composer]")!;
				form.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
				form.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
			}
		},
		kind,
		bytes.toString("base64"),
		name,
		type,
	);
}

/** Pick the chat's model in the stats bar's model control. */
async function pickModel(page: Page, id: string): Promise<void> {
	await page.click("[data-testid=stats-model]");
	await page.waitForSelector("[data-testid=model-search]", { timeout: 30_000 });
	await page.type("[data-testid=model-search]", id);
	await page.click(`[data-testid=model-option-${id}]`);
	await until(async () => (await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "")).includes(id), `the ${id} model`);
}

/** Every intake request the page makes (image loads by id aside), as "METHOD path?query". */
function attachmentRequests(page: Page): string[] {
	const seen: string[] = [];
	page.on("request", (r) => {
		const url = new URL(r.url());
		if (url.pathname === "/api/attachments" || url.pathname === "/api/attachments/file") seen.push(`${r.method()} ${url.pathname}${url.search}`);
	});
	return seen;
}

/** Upload one image straight to the store for a chat. */
async function store(chat: string, bytes: Buffer, name: string): Promise<{ id: string; name?: string }> {
	const form = new FormData();
	form.append("chatId", chat);
	form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
	const res = await fetch(`${server.url}/api/attachments`, { method: "POST", body: form });
	return ((await res.json()) as { attachment: { id: string } }).attachment;
}

/** Send one text message through the API and wait for its turn to settle. */
async function sendViaApi(chat: string, text: string, attachments: unknown[], userTurns: number): Promise<StubRequest> {
	const before = stub.requests.length;
	const res = await server.api("/api/chat", { body: { chatId: chat, input: { type: "text", text, ...(attachments.length ? { attachments } : {}) } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	await settled(chat, userTurns);
	return stub.requests.slice(before).filter((r) => !isSummary(r)).at(-1)!;
}

async function sendFromComposer(page: Page, text: string): Promise<void> {
	await page.type("[data-testid=composer] textarea", text);
	await page.keyboard.press("Enter");
}

async function settled(id: string, userTurns: number) {
	return until(async () => {
		const c = await server.json<{ messages: Array<{ role: string; attachments?: unknown[]; customType?: string }>; turnInFlight: boolean }>(`/api/chats/${id}`);
		// Markers (the compaction's) may follow the reply; the turn is done
		// once the newest model-facing message is the assistant's.
		const last = c.messages.filter((m) => m.role !== "custom").at(-1);
		return !c.turnInFlight && c.messages.filter((m) => m.role === "user").length >= userTurns && last?.role === "assistant" ? c : null;
	}, `turn ${userTurns} to settle`, 180_000);
}

test("(a)(b) paste, drop and path each attach, send, and land in the store", async () => {
	({ id: chatId } = await server.json<{ id: string }>("/api/chats", { body: { title: "Images" } }));
	const page = await chrome.browser.newPage();
	await openChat(page, chatId);

	// Paste a screenshot.
	await fileEvent(page, "paste", IMAGES.pasted, "screenshot.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	await sendFromComposer(page, "What is in this screenshot?");
	await settled(chatId, 1);
	let req = stub.requests.filter((r) => !isSummary(r)).at(-1)!;
	assert.ok(imagesIn(req).includes(IMAGES.pasted.toString("base64")), "the pasted image reached the provider");
	await until(() => page.$("[data-testid=attachment-chip]").then((c) => c === null), "the chip to clear after send");

	// Drop a file.
	await fileEvent(page, "drop", IMAGES.dropped, "diagram.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	await sendFromComposer(page, "And this diagram?");
	await settled(chatId, 2);
	req = stub.requests.filter((r) => !isSummary(r)).at(-1)!;
	assert.ok(imagesIn(req).includes(IMAGES.dropped.toString("base64")), "the dropped image reached the provider");

	// Type a path: the server copies the file and the path leaves the text.
	const byPath = path.join(originals, "byPath.png");
	await sendFromComposer(page, `Compare with ${byPath}`);
	const chat = await settled(chatId, 3);
	req = stub.requests.filter((r) => !isSummary(r)).at(-1)!;
	assert.ok(imagesIn(req).includes(IMAGES.byPath.toString("base64")), "the path-given image reached the provider");
	assert.ok(!lastUserText(req).includes(byPath), "the attached path was lifted out of the message text");

	const userMessages = chat.messages.filter((m) => m.role === "user");
	assert.deepEqual(
		userMessages.map((m) => (m.attachments as Array<{ id: string }>).map((a) => a.id)),
		[[idOf(IMAGES.pasted)], [idOf(IMAGES.dropped)], [idOf(IMAGES.byPath)]],
	);
	// (b) the store holds byte-exact copies under content-addressed names,
	// and the record holds references, never pixels.
	for (const bytes of Object.values(IMAGES)) {
		assert.deepEqual(fs.readFileSync(path.join(server.dataDir, "attachments", idOf(bytes))), bytes);
	}
	const raw = fs.readFileSync(path.join(server.dataDir, "chats", `${chatId}.json`), "utf8");
	assert.ok(!raw.includes(IMAGES.pasted.toString("base64")), "the chat record holds no base64 pixels");
	await page.close();
});

test("(d) after compaction the request carries references only", async () => {
	// The long message keeps the third image in the kept tail; its reply
	// reports a 160k context, so compaction runs at settle.
	const before = stub.requests.length;
	const res = await server.api("/api/chat", {
		body: { chatId, input: { type: "text", text: LONG, attachments: [{ id: idOf(IMAGES.byPath), name: "byPath.png" }] } },
	});
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	await settled(chatId, 4);
	assert.ok(imagesIn(stub.requests.slice(before).find((r) => !isSummary(r))!).length > 0, "pixels ride before compaction");
	const marker = await until(async () => {
		const c = await server.json<{ messages: Array<{ role: string; customType?: string; content?: unknown }> }>(`/api/chats/${chatId}`);
		return c.messages.find((m) => m.customType === "compaction");
	}, "the compaction marker", 180_000);
	const summaryReq = stub.requests.find(isSummary)!;
	assert.match(JSON.stringify(summaryReq.messages), new RegExp(idOf(IMAGES.pasted)), "the summarizer saw the image references");
	assert.match(String(marker.content), new RegExp(idOf(IMAGES.pasted)));
});

test("(c) originals deleted and server restarted: the chat renders and view_image loads the image", async () => {
	fs.rmSync(originals, { recursive: true, force: true });
	process.env.LH_E2E_KEEP = "1"; // keep the data dir across the restart
	await server.stop();
	delete process.env.LH_E2E_KEEP;
	server = await bootServer({ ticket: TICKET, providers, settings, env: { LH_DATA_DIR: dataDir } });
	{
		const page = await chrome.browser.newPage();
		await openChat(page, chatId);
		const loaded = await until(async () => {
			const sizes = await page.$$eval("[data-testid=user-message-image]", (imgs) =>
				imgs.map((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth),
			);
			return sizes.length >= 4 && sizes.every((w) => w === 4) ? sizes : null;
		}, "every transcript image to load from the store", 120_000);
		assert.equal(loaded.length, 4);
		await page.close();

		// (d) continued: the first post-compaction request has no pixels at
		// all — the summary names the summarized image, the kept tail names
		// its own — and view_image brings the pixels back.
		const before = stub.requests.length;
		const res = await server.api("/api/chat", { body: { chatId, input: { type: "text", text: VIEW_AGAIN } } });
		assert.equal(res.status, 200, await res.clone().text());
		await res.arrayBuffer();
		await settled(chatId, 5);
		const turn = stub.requests.slice(before).filter((r) => !isSummary(r));
		const [ask, afterTool] = [turn[0]!, turn.find((r) => calledTool(r, "view_image"))!];
		assert.deepEqual(imagesIn(ask), [], "no pixels after compaction");
		assert.match(JSON.stringify(ask.messages), new RegExp(`Shared images: [^"]*${idOf(IMAGES.pasted)}`));
		assert.match(JSON.stringify(ask.messages), new RegExp(`Image attached by the learner: ${idOf(IMAGES.byPath)}`));
		assert.ok(ask.tools.includes("view_image"));
		assert.deepEqual(imagesIn(afterTool), [IMAGES.pasted.toString("base64")], "view_image loaded the stored pixels");
	}
});

test("(e) a model that can't read images says so; the per-model override turns it on", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Text only" } });
	await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: "e2e-stub", id: "text-only" } } });
	const page = await chrome.browser.newPage();
	await openChat(page, id);
	await until(async () => (await page.$eval("[data-testid=stats-model]", (el) => el.textContent ?? "")).includes("text-only"), "the text-only model");

	await fileEvent(page, "paste", IMAGES.pasted, "screenshot.png");
	const notice = await page.waitForSelector("[data-testid=attachment-notice]", { timeout: 30_000 });
	assert.match((await notice!.evaluate((el) => el.textContent)) ?? "", /text-only can't read images/);
	assert.equal(await page.$("[data-testid=attachment-chip]"), null, "nothing attached");

	// The server refuses the same send outright (never a silent drop).
	const refused = await server.api("/api/chat", {
		body: { chatId: id, input: { type: "text", text: "see", attachments: [{ id: idOf(IMAGES.pasted) }] } },
	});
	assert.equal(refused.status, 400);
	assert.equal((await refused.json()).code, "images_unsupported");

	// Settings → Agent → Models → "Image input": turn it on for this
	// model. The override persists on disk and lifts the gate.
	await page.click("[data-testid=settings-entry]");
	await page.click("[data-testid=settings-nav-agent]");
	await page.waitForSelector("[data-testid=image-support-row] select:not([disabled])", { timeout: 60_000 });
	await page.select("[data-testid=image-support-model]", "e2e-stub:text-only");
	assert.equal(await page.$eval("[data-testid=image-support-value]", (el) => (el as HTMLSelectElement).value), "default");
	await page.select("[data-testid=image-support-value]", "on");
	const onDisk = await until(() => {
		const record = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
		return record.imageSupport?.["e2e-stub"]?.["text-only"] === true ? record : null;
	}, "the override on disk");
	assert.deepEqual(onDisk.imageSupport, { "e2e-stub": { "text-only": true } });
	await page.keyboard.press("Escape");
	await until(() => page.$("[data-testid=settings-dialog]").then((d) => d === null), "the settings dialog to close");
	await fileEvent(page, "paste", IMAGES.pasted, "screenshot.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	await page.close();
});

test("the wire carries at most 20 images per request, newest first", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Many images" } });
	const many = Array.from({ length: 21 }, (_, i) => png(i * 10, 100, 100));
	const refs = [];
	for (const [i, bytes] of many.entries()) {
		const form = new FormData();
		form.append("chatId", id);
		form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), `shot-${i}.png`);
		const res = await fetch(`${server.url}/api/attachments`, { method: "POST", body: form });
		refs.push(((await res.json()) as { attachment: { id: string } }).attachment);
	}
	const before = stub.requests.length;
	const res = await server.api("/api/chat", { body: { chatId: id, input: { type: "text", text: "All of these.", attachments: refs } } });
	assert.equal(res.status, 200, await res.clone().text());
	await res.arrayBuffer();
	await settled(id, 1);
	const req = stub.requests.slice(before).find((r) => !isSummary(r))!;
	const sent = imagesIn(req);
	assert.equal(sent.length, 20);
	assert.ok(!sent.includes(many[0]!.toString("base64")), "the oldest image rides as a reference");
	assert.match(JSON.stringify(req.messages), new RegExp(`Image attached by the learner: ${idOf(many[0]!)}`));
});

test("a 4000×3000 screenshot is downscaled to 2000 px before it is stored", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Big screenshot" } });
	const page = await chrome.browser.newPage();
	await openChat(page, id);
	await fileEvent(page, "paste", png(200, 120, 40, 4000, 3000), "retina.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 60_000 });
	const before = stub.requests.length;
	await sendFromComposer(page, "What does this show?");
	const chat = await settled(id, 1);
	const sent = imagesIn(stub.requests.slice(before).find((r) => !isSummary(r))!);
	assert.equal(sent.length, 1);
	// PNG or JPEG, whichever came out smaller.
	assert.deepEqual(imageDimensions(Buffer.from(sent[0]!, "base64")), { width: 2000, height: 1500 });
	const stored = (chat.messages[0]!.attachments as Array<{ id: string }>)[0]!.id;
	assert.deepEqual(imageDimensions(fs.readFileSync(path.join(dataDir, "attachments", stored))), { width: 2000, height: 1500 });
	await page.close();
});

test("a refused send puts its images back with the text", async () => {
	// gpt-5.5 reads images, but no OpenAI key exists: the send refuses
	// (provider_key_missing) and the draft returns to the composer.
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Refused" } });
	await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: "openai", id: "gpt-5.5" } } });
	const page = await chrome.browser.newPage();
	await openChat(page, id);
	await fileEvent(page, "paste", IMAGES.dropped, "diagram.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	await sendFromComposer(page, "Explain this diagram");
	// The refusal flow ran: it opens setup, and the record kept nothing.
	await page.waitForSelector("[data-testid=setup-backdrop]", { timeout: 60_000 });
	const record = await server.json<{ messages: Array<{ role: string }> }>(`/api/chats/${id}`);
	assert.equal(record.messages.filter((m) => m.role === "user").length, 0);
	await until(async () => {
		const value = await page.$eval("[data-testid=composer] textarea", (el) => (el as HTMLTextAreaElement).value);
		const chips = await page.$$("[data-testid=attachment-chip]");
		return value === "Explain this diagram" && chips.length === 1;
	}, "the text and the image chip to come back");
	await page.close();
});

test("the new-session page takes a pasted image into the first message", async () => {
	const page = await chrome.browser.newPage();
	await page.goto(`${server.url}/chat/new`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await page.waitForFunction(
		() => Object.keys(document.querySelector("[data-testid=composer] textarea") ?? {}).some((k) => k.startsWith("__reactProps")),
		{ timeout: 180_000 },
	);
	const image = png(90, 90, 200);
	await fileEvent(page, "paste", image, "first.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	const before = stub.requests.length;
	await sendFromComposer(page, "Teach me what this shows");
	await page.waitForFunction(() => /\/chat\/(?!new)[^/?]+/.test(location.pathname), { timeout: 60_000 });
	const id = await page.evaluate(() => location.pathname.split("/").pop()!);
	const chat = await settled(id, 1);
	assert.deepEqual((chat.messages[0]!.attachments as Array<{ id: string }>).map((a) => a.id), [idOf(image)]);
	assert.ok(stub.requests.slice(before).some((r) => imagesIn(r).includes(image.toString("base64"))), "the image reached the provider");
	await page.close();
});

test("a send refused for images puts the draft back with the reason; a model change clears it", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Switched to text" } });
	const page = await chrome.browser.newPage();
	await openChat(page, id);
	await fileEvent(page, "paste", IMAGES.dropped, "diagram.png");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	// The chip came in on a vision model; the send goes to a text-only one.
	await pickModel(page, "plain-text");
	await sendFromComposer(page, "Explain this diagram");
	const notice = await page.waitForSelector("[data-testid=attachment-notice]", { timeout: 60_000 });
	assert.match((await notice!.evaluate((el) => el.textContent)) ?? "", /plain-text can't read images/);
	await until(async () => {
		const value = await page.$eval("[data-testid=composer] textarea", (el) => (el as HTMLTextAreaElement).value);
		return value === "Explain this diagram" && (await page.$$("[data-testid=attachment-chip]")).length === 1;
	}, "the text and the image chip to come back");
	const record = await server.json<{ messages: Array<{ role: string }> }>(`/api/chats/${id}`);
	assert.equal(record.messages.filter((m) => m.role === "user").length, 0, "the refused send kept nothing");
	assert.equal(await page.evaluate(() => document.body.innerText.includes("Something went wrong")), false, "no raw error banner");

	await pickModel(page, "vision-a");
	await until(() => page.$("[data-testid=attachment-notice]").then((n) => n === null), "the notice to clear on the model change");
	await page.close();
});

test("a text-only chat refuses a paste before uploading it; the next send clears the notice", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Plain text" } });
	await server.json(`/api/chats/${id}/settings`, { method: "PUT", body: { model: { provider: "e2e-stub", id: "plain-text" } } });
	const page = await chrome.browser.newPage();
	const requests = attachmentRequests(page);
	await openChat(page, id);
	await fileEvent(page, "paste", png(240, 240, 10, 3000, 2000), "big.png");
	const notice = await page.waitForSelector("[data-testid=attachment-notice]", { timeout: 30_000 });
	assert.match((await notice!.evaluate((el) => el.textContent)) ?? "", /plain-text can't read images/);
	assert.deepEqual(requests, [`GET /api/attachments?check=1&chatId=${id}`], "only the gate check ran: no upload");

	// A path refused for the model is sent as text, and says so; the next
	// send clears that notice.
	const shot = path.join(path.dirname(dataDir), "plain.png");
	fs.writeFileSync(shot, IMAGES.pasted);
	await sendFromComposer(page, `Look at ${shot}`);
	await settled(id, 1);
	await until(async () => /The path was sent as text/.test(await page.$eval("[data-testid=attachment-notice]", (el) => el.textContent ?? "").catch(() => "")), "the path notice");
	await sendFromComposer(page, "Thanks");
	await settled(id, 2);
	await until(() => page.$("[data-testid=attachment-notice]").then((n) => n === null), "the notice to clear after the send");

	// A plain-text steer to this chat is never an image refusal (no turn
	// is live, so it 409s).
	const steer = await server.api(`/api/chats/${id}/steer`, { body: { input: { type: "steer", id: "steer_plain", text: "one more thing" } } });
	assert.equal(steer.status, 409, await steer.clone().text());
	await page.close();
});

test("a BMP the browser decodes is converted to PNG before it is stored", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "BMP" } });
	const page = await chrome.browser.newPage();
	await openChat(page, id);
	await fileEvent(page, "paste", bmp(10, 120, 230), "old.bmp", "image/bmp");
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 30_000 });
	await sendFromComposer(page, "What is this?");
	const chat = await settled(id, 1);
	const stored = (chat.messages[0]!.attachments as Array<{ id: string }>)[0]!.id;
	assert.match(stored, /\.png$/);
	assert.deepEqual(imageDimensions(fs.readFileSync(path.join(dataDir, "attachments", stored))), { width: 8, height: 8 });
	await page.close();
});

test("a large JPEG photo is downscaled and stays JPEG", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Photo" } });
	const page = await chrome.browser.newPage();
	await openChat(page, id);
	// A 4000×3000 photo-like JPEG, made in the page. The PNG the old
	// encoder would have kept is reported too: it fits the cap, so only
	// the JPEG preference makes the stored copy a .jpg.
	// (A string, not a function: tsx's helpers don't exist in the page.)
	const pngBytes = (await page.evaluate(`(async () => {
		const draw = (w, h) => {
			const c = document.createElement("canvas");
			c.width = w;
			c.height = h;
			const ctx = c.getContext("2d");
			const g = ctx.createLinearGradient(0, 0, w, h);
			g.addColorStop(0, "#3a6ea5");
			g.addColorStop(1, "#f2c14e");
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, w, h);
			return c;
		};
		const blob = (c, type) => new Promise((resolve) => c.toBlob(resolve, type, 0.92));
		const photo = await blob(draw(4000, 3000), "image/jpeg");
		const dt = new DataTransfer();
		dt.items.add(new File([photo], "photo.jpg", { type: "image/jpeg" }));
		document.querySelector("[data-testid=composer] textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
		return (await blob(draw(2000, 1500), "image/png")).size;
	})()`)) as number;
	assert.ok(pngBytes <= MAX_ATTACHMENT_BYTES, `the PNG alternative fits the cap (${pngBytes} bytes)`);
	await page.waitForSelector("[data-testid=attachment-chip]", { timeout: 60_000 });
	await sendFromComposer(page, "What is in this photo?");
	const chat = await settled(id, 1);
	const stored = (chat.messages[0]!.attachments as Array<{ id: string }>)[0]!.id;
	assert.match(stored, /\.jpg$/);
	assert.deepEqual(imageDimensions(fs.readFileSync(path.join(dataDir, "attachments", stored))), { width: 2000, height: 1500 });
	await page.close();
});

test("an image attached twice keeps its pixels where they first rode", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Twice" } });
	const twice = png(70, 20, 140);
	const ref = await store(id, twice, "twice.png");
	const first = await sendViaApi(id, "Here is the chart.", [ref], 1);
	const second = await sendViaApi(id, "The same chart again.", [ref], 2);
	assert.deepEqual(imagesIn(second), [twice.toString("base64")], "one copy per request");
	const firstUser = (req: StubRequest) => JSON.stringify(req.messages.find((m) => m.role === "user"));
	assert.equal(firstUser(second), firstUser(first), "the earlier message is byte-identical across requests");
	assert.ok(firstUser(second).includes(twice.toString("base64")), "the pixels stay in the first message");
});

test("a tool result's inline image counts against the per-request budget", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Read then attach" } });
	const before = stub.requests.length;
	await sendViaApi(id, READ_ASK, [], 1);
	const turn = stub.requests.slice(before);
	assert.ok(turn[0]!.tools.includes("read"), "the read tool is offered");
	assert.ok(turn.some((r) => calledTool(r, "read") && imagesIn(r).includes(READ_IMAGE.toString("base64"))), "the read image rode inline");
	const refs = [];
	for (let i = 0; i < 20; i++) refs.push(await store(id, png(i * 12, 30, 200), `shot-${i}.png`));
	const req = await sendViaApi(id, "And these twenty.", refs, 2);
	const sent = imagesIn(req);
	assert.equal(sent.length, 20, "the budget holds every image block to 20");
	assert.ok(!sent.includes(READ_IMAGE.toString("base64")), "the oldest, the read image, became text");
	assert.match(JSON.stringify(req.messages), /left out of this request to stay within the image limit/);
});

test("a path image that fits is stored by the server; a big one is fitted first", async () => {
	const { id } = await server.json<{ id: string }>("/api/chats", { body: { title: "Paths" } });
	const dir = path.dirname(dataDir);
	const small = png(15, 15, 90);
	const big = png(150, 15, 90, 4000, 3000);
	fs.writeFileSync(path.join(dir, "small.png"), small);
	fs.writeFileSync(path.join(dir, "big.png"), big);
	const page = await chrome.browser.newPage();
	const requests = attachmentRequests(page);
	await openChat(page, id);
	await sendFromComposer(page, `Compare ${path.join(dir, "small.png")}`);
	let chat = await settled(id, 1);
	assert.deepEqual((chat.messages[0]!.attachments as Array<{ id: string }>).map((a) => a.id), [idOf(small)]);
	assert.deepEqual(requests, ["POST /api/attachments/file"], "stored server-side: no upload round trip");

	requests.length = 0;
	await sendFromComposer(page, `and ${path.join(dir, "big.png")}`);
	chat = await settled(id, 2);
	const stored = (chat.messages.filter((m) => m.role === "user")[1]!.attachments as Array<{ id: string }>)[0]!.id;
	assert.deepEqual(imageDimensions(fs.readFileSync(path.join(dataDir, "attachments", stored))), { width: 2000, height: 1500 });
	assert.deepEqual(requests, ["POST /api/attachments/file", "POST /api/attachments"], "the big one went through the composer's fit");
	await page.close();
});

test("a new session's first message still sends when its path can't be attached", async () => {
	const page = await chrome.browser.newPage();
	// The path read answers with a body that isn't the JSON it claims to be.
	await page.setRequestInterception(true);
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/attachments/file") void r.respond({ status: 200, contentType: "application/json", body: "{not json" });
		else void r.continue();
	});
	await page.goto(`${server.url}/chat/new`, { waitUntil: "domcontentloaded", timeout: 180_000 });
	await page.waitForFunction(
		() => Object.keys(document.querySelector("[data-testid=composer] textarea") ?? {}).some((k) => k.startsWith("__reactProps")),
		{ timeout: 180_000 },
	);
	const prompt = "Teach me what /nowhere/lh39/diagram.png shows";
	await sendFromComposer(page, prompt);
	await page.waitForFunction(() => /\/chat\/(?!new)[^/?]+/.test(location.pathname), { timeout: 60_000 });
	const id = await page.evaluate(() => location.pathname.split("/").pop()!);
	const chat = await settled(id, 1);
	assert.equal((chat.messages[0] as { content?: unknown }).content, prompt, "the text went, with the path as typed");
	await page.close();
});

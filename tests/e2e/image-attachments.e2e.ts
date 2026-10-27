import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
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

const IMAGES = { pasted: png(220, 30, 30), dropped: png(30, 200, 40), byPath: png(30, 40, 210) };
const idOf = (bytes: Buffer) => `${createHash("sha256").update(bytes).digest("hex")}.png`;

/** Every base64 image payload a request carried. */
function imagesIn(req: StubRequest): string[] {
	return [...JSON.stringify(req.messages).matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]!);
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
		],
	});
	server = await bootServer({ ticket: TICKET, providers, settings });
	dataDir = server.dataDir;
	chrome = await launchChrome(TICKET);
	originals = fs.mkdtempSync(path.join(os.homedir(), ".cache", "lh-e2e", TICKET, "originals-"));
	for (const [name, bytes] of Object.entries(IMAGES)) fs.writeFileSync(path.join(originals, `${name}.png`), bytes);
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

/** Fire a paste or drop of one PNG file on the composer, as the browser would. */
async function fileEvent(page: Page, kind: "paste" | "drop", bytes: Buffer, name: string): Promise<void> {
	await page.evaluate(
		(kind, b64, name) => {
			const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const dt = new DataTransfer();
			dt.items.add(new File([data], name, { type: "image/png" }));
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
	);
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

/** The pixel size of a PNG payload (IHDR), or null for other formats. */
function pngSize(b64: string): { width: number; height: number } | null {
	const bytes = Buffer.from(b64, "base64");
	return bytes.readUInt32BE(0) === 0x89504e47 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

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
	assert.deepEqual(pngSize(sent[0]!), { width: 2000, height: 1500 });
	const stored = (chat.messages[0]!.attachments as Array<{ id: string }>)[0]!.id;
	assert.deepEqual(pngSize(fs.readFileSync(path.join(dataDir, "attachments", stored)).toString("base64")), { width: 2000, height: 1500 });
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

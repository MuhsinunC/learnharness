/**
 * The attachment store (LH-39): the learner's images, copied into
 * <data>/attachments/<sha256>.<ext> (PATHS.attachments, under the
 * LH_DATA_DIR seam). Content-addressed — the same bytes always land on
 * the same file, so re-attaching deduplicates — and owned by the app for
 * good: the original file, a temp dir, or the clipboard can go away and
 * every chat still renders and re-reads its images. Nothing here deletes.
 *
 * Every read goes through isAttachmentId (core/attachments.ts): the id
 * regex is the only key, so no caller-supplied path is ever joined.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS } from "../../config.ts";
import {
	ATTACHMENT_MIME,
	MAX_ATTACHMENT_BYTES,
	attachmentMime,
	isAttachmentId,
	sniffImageExt,
	type AttachmentRef,
} from "../core/attachments.ts";

/** A refusal the routes report verbatim (400). */
export class AttachmentError extends Error {}

// turbopackIgnore on every fs call here: store paths and learner paths are
// runtime values, and without the comment Next's output file tracing treats
// them as "anything under the project", sweeping .git, tests and docs into
// the standalone server (the desktop build then failed codesign on .git's
// read-only pack files, PR #78 CI; scripts/build-server.mjs now refuses it).
function fileFor(id: string): string {
	if (!isAttachmentId(id)) throw new AttachmentError(`invalid attachment id: ${id}`);
	return path.join(PATHS.attachments, id);
}

/** Copy bytes into the store (idempotent by content). The write goes to a
 *  temp file in the store dir and renames, so a crash never leaves a
 *  half-written image under a valid id. */
export function saveAttachment(bytes: Uint8Array, name?: string): AttachmentRef {
	if (bytes.byteLength === 0) throw new AttachmentError("the image is empty");
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentError(`the image is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
	}
	const ext = sniffImageExt(bytes);
	if (!ext) throw new AttachmentError(`only ${Object.keys(ATTACHMENT_MIME).join(", ")} images can be attached`);
	const id = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
	const file = fileFor(id);
	if (!fs.existsSync(/* turbopackIgnore: true */ file)) {
		fs.mkdirSync(/* turbopackIgnore: true */ PATHS.attachments, { recursive: true });
		const tmp = path.join(PATHS.attachments, `.${randomUUID()}.tmp`);
		fs.writeFileSync(/* turbopackIgnore: true */ tmp, bytes);
		fs.renameSync(/* turbopackIgnore: true */ tmp, file);
	}
	return { id, mimeType: attachmentMime(id), ...(name ? { name } : {}) };
}

/** Expand what a learner pastes as a path: `~/…`, `file://…`, and the
 *  quoting or backslash-escaped spaces a terminal drag produces. */
export function expandLearnerPath(raw: string): string {
	let p = raw.trim();
	if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
	if (p.startsWith("file://")) return fileURLToPath(p);
	p = p.replace(/\\ /g, " ");
	if (p === "~" || p.startsWith("~/")) p = path.join(/* turbopackIgnore: true */ os.homedir(), p.slice(1));
	return path.resolve(/* turbopackIgnore: true */ os.homedir(), p);
}

/** Files larger than this are not read for an attach at all: the
 *  composer downscales what it gets, but a 64 MB screenshot is no image. */
const MAX_PATH_READ_BYTES = 64 * 1024 * 1024;

/** Read the image at a learner-given path (nothing is stored here).
 *  Async, so a large file never blocks the request thread, and capped:
 *  the read stops at MAX_PATH_READ_BYTES even if the file grew after the
 *  stat. Image formats only, by magic bytes. */
export async function readImageFile(raw: string): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
	const file = expandLearnerPath(raw);
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(/* turbopackIgnore: true */ file, "r");
	} catch {
		throw new AttachmentError(`no file at ${file}`);
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new AttachmentError(`${file} is not a file`);
		if (stat.size > MAX_PATH_READ_BYTES) throw new AttachmentError(`${file} is too large to attach`);
		const buffer = Buffer.alloc(stat.size);
		const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
		const bytes = buffer.subarray(0, bytesRead);
		const ext = sniffImageExt(bytes);
		if (!ext) throw new AttachmentError(`only ${Object.keys(ATTACHMENT_MIME).join(", ")} images can be attached`);
		return { bytes, name: path.basename(file), mimeType: ATTACHMENT_MIME[ext]! };
	} finally {
		await handle.close();
	}
}

export function attachmentExists(id: string): boolean {
	return isAttachmentId(id) && fs.existsSync(/* turbopackIgnore: true */ fileFor(id));
}

/** The stored bytes, or null when the id is malformed or absent. */
export function readAttachment(id: string): Buffer | null {
	if (!attachmentExists(id)) return null;
	return fs.readFileSync(/* turbopackIgnore: true */ fileFor(id));
}

/** The wire hydrator toLlmMessages takes: pi's ImageContent, or null. */
export function loadAttachmentImage(id: string): { type: "image"; data: string; mimeType: string } | null {
	const bytes = readAttachment(id);
	return bytes ? { type: "image", data: bytes.toString("base64"), mimeType: attachmentMime(id) } : null;
}

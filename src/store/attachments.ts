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
	if (!fs.existsSync(file)) {
		fs.mkdirSync(PATHS.attachments, { recursive: true });
		const tmp = path.join(PATHS.attachments, `.${randomUUID()}.tmp`);
		fs.writeFileSync(tmp, bytes);
		fs.renameSync(tmp, file);
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
	if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
	return path.resolve(os.homedir(), p);
}

/** Copy the image at a learner-given path into the store. */
export function saveAttachmentFromPath(raw: string): AttachmentRef {
	const file = expandLearnerPath(raw);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		throw new AttachmentError(`no file at ${file}`);
	}
	if (!stat.isFile()) throw new AttachmentError(`${file} is not a file`);
	if (stat.size > MAX_ATTACHMENT_BYTES) {
		throw new AttachmentError(`the image is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
	}
	return saveAttachment(fs.readFileSync(file), path.basename(file));
}

export function attachmentExists(id: string): boolean {
	return isAttachmentId(id) && fs.existsSync(fileFor(id));
}

/** The stored bytes, or null when the id is malformed or absent. */
export function readAttachment(id: string): Buffer | null {
	if (!attachmentExists(id)) return null;
	return fs.readFileSync(fileFor(id));
}

/** The wire hydrator toLlmMessages takes: pi's ImageContent, or null. */
export function loadAttachmentImage(id: string): { type: "image"; data: string; mimeType: string } | null {
	const bytes = readAttachment(id);
	return bytes ? { type: "image", data: bytes.toString("base64"), mimeType: attachmentMime(id) } : null;
}

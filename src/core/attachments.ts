/**
 * IMAGE ATTACHMENTS (LH-39, 2026-10-27): the learner's pasted, dropped, or
 * path-given images. The record never holds pixels — a user message
 * carries `attachments` (references into the app's own content-addressed
 * store, <data>/attachments/<sha256>.<ext>), and toLlmMessages hydrates
 * the pixels at the wire only for messages newer than the active
 * compaction marker. Older references reach the model as text naming the
 * id; the view_image tool loads the pixels again on demand.
 * See docs/image-attachments.md.
 *
 * Pure and browser-safe: the store itself is src/store/attachments.ts.
 */

/** One stored image as the record references it. `id` is the store
 *  filename (sha256 of the bytes + the sniffed extension); `name` is the
 *  learner-facing original filename, display only. */
export interface AttachmentRef {
	id: string;
	mimeType: string;
	name?: string;
}

/** The store's id shape — the ONLY way into the store (no path joins on
 *  anything else, so traversal is unreachable by construction). */
export const ATTACHMENT_ID_RE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

/** The formats every vision provider in the catalog accepts (Claude:
 *  JPEG, PNG, GIF, WebP — no BMP). */
export const ATTACHMENT_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** Per-image byte cap: Claude's API takes 10 MB base64 per image (about
 *  7.5 MB raw); nothing here resizes, so bigger images refuse up front. */
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

export function isAttachmentId(id: unknown): id is string {
	return typeof id === "string" && ATTACHMENT_ID_RE.test(id);
}

/** The MIME type an id's extension names (the id regex pins the set). */
export function attachmentMime(id: string): string {
	return ATTACHMENT_MIME[id.slice(id.lastIndexOf(".") + 1)]!;
}

/** Sniff the image format from magic bytes — never the filename. */
export function sniffImageExt(bytes: Uint8Array): keyof typeof ATTACHMENT_MIME | null {
	const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
	if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
	return null;
}

/** The image-reading tool's name (single-sourced: the tool, the wire
 *  hydration, and the reference text all name it). */
export const VIEW_IMAGE_TOOL = "view_image";

/** The model-facing reference text for one attachment — always present,
 *  pixels or not, so the agent can name the image to view_image later. */
export function attachmentReferenceText(ref: AttachmentRef): string {
	return `[Image attached by the learner: ${ref.id}${ref.name ? ` (${ref.name})` : ""}. If it is not shown, call ${VIEW_IMAGE_TOOL} with this id to see it.]`;
}

/** The learner-facing words for a model that can't take images — the
 *  composer's notice and the server's refusal share them. */
export function imagesUnsupportedText(model: { name?: string; id: string }): string {
	return `${model.name || model.id} can't read images. Pick a model that accepts images, or turn image input on for this model in Settings → Agent → Models.`;
}

/** The refusal when the chat's model cannot take images (POST /api/chat
 *  and the steer route — never a silent downgrade). */
export const IMAGES_UNSUPPORTED_CODE = "images_unsupported" as const;

/** Effective image support for one (provider, model): the learner's
 *  persisted override wins, else the catalog's `input` metadata. */
export function supportsImages(
	model: { provider: string; id: string; input: readonly string[] },
	overrides: ImageSupportSettings | undefined,
): boolean {
	const override = overrides?.[model.provider]?.[model.id];
	return typeof override === "boolean" ? override : model.input.includes("image");
}

/** The `imageSupport` settings section: provider → model id → override.
 *  Absent pairs resolve from the catalog. */
export type ImageSupportSettings = Record<string, Record<string, boolean>>;

/** Clean an overrides map (disk or network): booleans only, nothing else. */
export function sanitizeImageSupport(raw: unknown): ImageSupportSettings {
	const out: ImageSupportSettings = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [provider, models] of Object.entries(raw as Record<string, unknown>)) {
		if (models === null || typeof models !== "object" || Array.isArray(models)) continue;
		const kept: Record<string, boolean> = {};
		for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
			if (typeof value === "boolean") kept[id] = value;
		}
		if (Object.keys(kept).length) out[provider] = kept;
	}
	return out;
}

/** Parse the attachments of a text/steer input event: an optional array
 *  of refs with valid store ids (mimeType derives from the id; the name
 *  is display-only and capped). Existence is the server's check. */
export function parseAttachmentRefs(raw: unknown): AttachmentRef[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const out: AttachmentRef[] = [];
	for (const item of raw) {
		const r = item as { id?: unknown; name?: unknown } | null;
		if (!r || !isAttachmentId(r.id)) return null;
		out.push({
			id: r.id,
			mimeType: attachmentMime(r.id),
			...(typeof r.name === "string" && r.name ? { name: r.name.slice(0, 200) } : {}),
		});
	}
	return out;
}

/** Image paths a learner typed or pasted into a message: absolute,
 *  `~/`, or `file://` paths ending in an image extension, bare or quoted,
 *  with terminal-style escaped spaces. Each match carries its exact span
 *  so the composer can lift attached paths out of the text. */
export function findImagePaths(text: string): { path: string; start: number; end: number }[] {
	const out: { path: string; start: number; end: number }[] = [];
	const token = /(?<=^|\s)(?:(['"])((?:file:\/\/|~\/|\/)[^'"\n]+?)\1|(?:file:\/\/|~\/|\/)(?:\\ |[^\s'"])+)/g;
	for (const m of text.matchAll(token)) {
		const path = m[2] ?? m[0];
		if (/\.(png|jpe?g|gif|webp)$/i.test(path)) out.push({ path, start: m.index, end: m.index + m[0].length });
	}
	return out;
}

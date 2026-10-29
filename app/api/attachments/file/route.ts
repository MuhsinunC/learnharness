/**
 * POST /api/attachments/file — attach the image at a path the learner
 * typed or pasted (LH-39): {path, chatId?}. The server is the learner's
 * own machine, so it reads the path itself. An image already within the
 * byte cap and MAX_IMAGE_EDGE is stored here directly: 200 {attachment}.
 * Anything bigger comes back as its bytes (200, the image's own type)
 * for the composer to fit and upload to POST /api/attachments like a
 * paste. Images only (sniffed); the chat's model gate runs first (400
 * images_unsupported).
 */
import { imageDimensions, MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE } from "@/src/core";
import { AttachmentError, chatIntakeRefusal, getChat, readImageFile, saveAttachment } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { path?: unknown; chatId?: unknown } | null;
	if (typeof body?.path !== "string" || !body.path.trim()) {
		return Response.json({ error: "path must be a non-empty string" }, { status: 400 });
	}
	if (body.chatId !== undefined && (typeof body.chatId !== "string" || !getChat(body.chatId))) {
		return Response.json({ error: "unknown chat" }, { status: 404 });
	}
	const refusal = chatIntakeRefusal(body.chatId as string | undefined);
	if (refusal) return refusal;
	try {
		const { bytes, name, mimeType } = await readImageFile(body.path);
		const size = imageDimensions(bytes);
		if (size && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE && bytes.byteLength <= MAX_ATTACHMENT_BYTES) {
			return Response.json({ attachment: saveAttachment(bytes, name) });
		}
		// A view over the read buffer, no copy (a file read never yields a SharedArrayBuffer).
		return new Response(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), {
			headers: { "Content-Type": mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
		});
	} catch (err) {
		if (err instanceof AttachmentError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

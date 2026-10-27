/**
 * POST /api/attachments/file — read the image at a path the learner typed
 * or pasted (LH-39): {path, chatId?} → the image bytes. The server is the
 * learner's own machine; the composer fits the image and uploads it to
 * POST /api/attachments like a paste, so the store keeps its own copy and
 * the original can go. Images only (sniffed); the chat's model gate runs
 * first (400 images_unsupported).
 */
import { AttachmentError, chatImageRefusal, getChat, readImageFile } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { path?: unknown; chatId?: unknown } | null;
	if (typeof body?.path !== "string" || !body.path.trim()) {
		return Response.json({ error: "path must be a non-empty string" }, { status: 400 });
	}
	if (body.chatId !== undefined && (typeof body.chatId !== "string" || !getChat(body.chatId))) {
		return Response.json({ error: "unknown chat" }, { status: 404 });
	}
	const refusal = chatImageRefusal(body.chatId as string | undefined);
	if (refusal) return refusal;
	try {
		const { bytes, name, mimeType } = readImageFile(body.path);
		return new Response(new Uint8Array(bytes), {
			headers: { "Content-Type": mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
		});
	} catch (err) {
		if (err instanceof AttachmentError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

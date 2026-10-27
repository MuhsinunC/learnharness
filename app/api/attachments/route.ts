/**
 * POST /api/attachments — copy one learner image into the attachment
 * store (LH-39). Two bodies:
 *   multipart form, fields "file" (a pasted or dropped image) and "chatId";
 *   JSON {path, chatId} — a path the learner typed or pasted; the server
 *     (the learner's own machine) copies the file, so the original can go.
 * 200 {attachment: AttachmentRef}. 400 with the reason on anything that is
 * not a png/jpeg/gif/webp within the size cap, and 400 images_unsupported
 * when the chat's model can't read images (nothing is stored then).
 * Content-addressed: the same image posted twice returns the same id.
 */
import { AttachmentError, chatImageRefusal, getChat, saveAttachment, saveAttachmentFromPath } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const json = request.headers.get("content-type")?.includes("application/json");
	const body = json
		? ((await request.json().catch(() => null)) as { path?: unknown; chatId?: unknown } | null)
		: await request.formData();
	const chatId = body instanceof FormData ? body.get("chatId") : body?.chatId;
	if (typeof chatId !== "string" || !getChat(chatId)) return Response.json({ error: "unknown chat" }, { status: 404 });
	const refusal = chatImageRefusal(chatId);
	if (refusal) return refusal;
	try {
		if (body instanceof FormData) {
			const file = body.get("file");
			if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
			return Response.json({ attachment: saveAttachment(new Uint8Array(await file.arrayBuffer()), file.name || undefined) });
		}
		if (typeof body?.path !== "string" || !body.path.trim()) {
			return Response.json({ error: "path must be a non-empty string" }, { status: 400 });
		}
		return Response.json({ attachment: saveAttachmentFromPath(body.path) });
	} catch (err) {
		if (err instanceof AttachmentError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

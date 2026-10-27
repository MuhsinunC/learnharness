/**
 * POST /api/attachments — copy one learner image into the attachment
 * store (LH-39). Multipart form: "file" (a pasted, dropped, or path-read
 * image, already fitted by the composer) and "chatId" (absent on the
 * new-session draft, which gates on the strong slot). 200 {attachment};
 * 400 with the reason on anything that is not a png/jpeg/gif/webp within
 * the size cap; 400 images_unsupported when the chat's model can't read
 * images (nothing is stored then). Content-addressed: the same image
 * posted twice returns the same id.
 *
 * GET /api/attachments?check=1&chatId=… — the same model gate alone, so
 * the composer can refuse before it decodes or uploads anything: 200
 * {ok: true}, or the refusal.
 */
import { AttachmentError, chatIntakeRefusal, getChat, saveAttachment } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	const params = new URL(request.url).searchParams;
	if (params.get("check") !== "1") return Response.json({ error: "check=1 is required" }, { status: 400 });
	const chatId = params.get("chatId") ?? undefined;
	if (chatId !== undefined && !getChat(chatId)) return Response.json({ error: "unknown chat" }, { status: 404 });
	return chatIntakeRefusal(chatId) ?? Response.json({ ok: true });
}

export async function POST(request: Request): Promise<Response> {
	const form = await request.formData().catch(() => null);
	const chatId = form?.get("chatId");
	if (chatId !== null && chatId !== undefined && (typeof chatId !== "string" || !getChat(chatId))) {
		return Response.json({ error: "unknown chat" }, { status: 404 });
	}
	const refusal = chatIntakeRefusal(chatId ?? undefined);
	if (refusal) return refusal;
	const file = form?.get("file");
	if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
	try {
		return Response.json({ attachment: saveAttachment(new Uint8Array(await file.arrayBuffer()), file.name || undefined) });
	} catch (err) {
		if (err instanceof AttachmentError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

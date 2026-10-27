/**
 * POST /api/attachments — copy one learner image into the attachment
 * store (LH-39). Two bodies:
 *   multipart form, field "file" — a pasted or dropped image (bytes);
 *   JSON {path} — a path the learner typed or pasted; the server (the
 *     learner's own machine) copies the file, so the original can go.
 * 200 {attachment: AttachmentRef}; 400 with the reason on anything that is
 * not a png/jpeg/gif/webp within the size cap. Content-addressed: the
 * same image posted twice returns the same id.
 */
import { AttachmentError, saveAttachment, saveAttachmentFromPath } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	try {
		if (request.headers.get("content-type")?.includes("application/json")) {
			const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
			if (typeof body?.path !== "string" || !body.path.trim()) {
				return Response.json({ error: "path must be a non-empty string" }, { status: 400 });
			}
			return Response.json({ attachment: saveAttachmentFromPath(body.path) });
		}
		const file = (await request.formData()).get("file");
		if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
		return Response.json({ attachment: saveAttachment(new Uint8Array(await file.arrayBuffer()), file.name || undefined) });
	} catch (err) {
		if (err instanceof AttachmentError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

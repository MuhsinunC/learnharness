/**
 * GET /api/attachments/[id] — one stored learner image (LH-39), for the
 * composer chip and the transcript. The id is the content hash, so the
 * bytes behind it never change: cache forever.
 */
import { attachmentMime, isAttachmentId } from "@/src/core";
import { readAttachment } from "@/src/server";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const bytes = isAttachmentId(id) ? readAttachment(id) : null;
	if (!bytes) return Response.json({ error: "unknown attachment" }, { status: 404 });
	return new Response(new Uint8Array(bytes), {
		headers: { "Content-Type": attachmentMime(id), "Cache-Control": "private, max-age=31536000, immutable" },
	});
}

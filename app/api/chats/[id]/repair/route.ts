// POST /api/chats/[id]/repair — "Repair this chat" (LH-40): compacts a
// chat that grew past its model's real context window, toward that
// window, and saves the result (src/server/context-recovery.ts). 409
// while a turn or a compaction holds the chat; 422 when nothing older
// can be condensed.
import { handleRepairRequest } from "@/src/server";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return handleRepairRequest(id);
}

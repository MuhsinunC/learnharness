/** POST /api/chats/[id]/repair (LH-40): null when the chat was repaired,
 *  else the reason to show — the route's own refusal text (409, 422, 503)
 *  or a network failure. Shared by the error banner and the session menu. */
export async function repairChatRequest(chatId: string): Promise<string | null> {
	try {
		const res = await fetch(`/api/chats/${chatId}/repair`, { method: "POST" });
		if (res.ok) return null;
		const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
		return typeof body?.error === "string" ? body.error : `Repair failed (${res.status}).`;
	} catch {
		return "Repair failed: the app could not be reached.";
	}
}

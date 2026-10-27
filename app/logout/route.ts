/** POST /logout (LH-43): revokes this browser's session and returns to the login page. */
import { CLEAR_SESSION_COOKIE, revokeSession, sessionToken } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	revokeSession(sessionToken(req.headers));
	return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": CLEAR_SESSION_COOKIE, "Cache-Control": "no-store" } });
}

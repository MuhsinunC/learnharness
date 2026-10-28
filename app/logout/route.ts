/** POST /logout (LH-43): revokes this browser's session and returns to the
 * login page. Same-origin only, so another site cannot log the learner out. */
import { CLEAR_SESSION_COOKIE, revokeSession, sameOriginRequest, sessionToken } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	if (!sameOriginRequest(req.headers)) return Response.json({ error: "Log out from LearnHarness itself." }, { status: 403 });
	revokeSession(sessionToken(req.headers));
	return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": CLEAR_SESSION_COOKIE, "Cache-Control": "no-store" } });
}

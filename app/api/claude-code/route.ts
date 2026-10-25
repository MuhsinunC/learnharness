import { getClaudeCodeStatus, putClaudeCodeConnection } from "@/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
	return Response.json(await getClaudeCodeStatus());
}
export const PUT = putClaudeCodeConnection;

import { getClaudeCodeConnection, putClaudeCodeConnection } from "@/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = getClaudeCodeConnection;
export const PUT = putClaudeCodeConnection;

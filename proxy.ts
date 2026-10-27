import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { ACCESS_HEADER, decideAccess } from "./src/server/web-login.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Web login (LH-43): the one place pages, API, SSE and exports are gated,
 * in web mode and in the desktop app alike.
 * Local requests and valid sessions pass, stamped with ACCESS_HEADER for
 * the routes that care; everyone else gets 401 JSON or the login page. */
export function proxy(request: NextRequest) {
	const headers = new Headers(request.headers);
	headers.delete(ACCESS_HEADER);
	const { pathname, search } = request.nextUrl;
	const api = pathname.startsWith("/api");
	let access = decideAccess(request.headers);
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) {
		// Desktop: only the window's per-launch secret makes an API call local.
		// A phone behind tailscale serve gets in with its session, like web mode.
		if (api) access = desktopAPIAuthorized(request.headers) ? "local" : access === "session" ? "session" : null;
		if (api && !access) {
			return NextResponse.json(
				{ error: "Desktop API access requires the trusted LearnHarness window." },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
	}
	if (access) headers.set(ACCESS_HEADER, access);
	if (access || pathname === "/login") return NextResponse.next({ request: { headers } });
	if (api) {
		return NextResponse.json({ error: "Log in to LearnHarness first." }, { status: 401, headers: { "Cache-Control": "no-store" } });
	}
	// An absolute URL on Next's own origin: Next rewrites it to a relative
	// Location, so a phone behind tailscale serve stays on the ts.net name.
	const login = new URL("/login", request.url);
	login.searchParams.set("next", pathname + search);
	return NextResponse.redirect(login, 303);
}

export const config = { matcher: "/((?!_next/).*)" };

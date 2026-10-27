import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { ACCESS_HEADER, decideAccess } from "./src/server/web-login.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Web mode (LH-43): the one place pages, API, SSE and exports are gated.
 * Local requests and valid sessions pass, stamped with ACCESS_HEADER for
 * the routes that care; everyone else gets 401 JSON or the login page. */
export function proxy(request: NextRequest) {
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) {
		if (request.nextUrl.pathname.startsWith("/api") && !desktopAPIAuthorized(request.headers)) {
			return NextResponse.json(
				{ error: "Desktop API access requires the trusted LearnHarness window." },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
		return NextResponse.next();
	}
	const headers = new Headers(request.headers);
	headers.delete(ACCESS_HEADER);
	const access = decideAccess(request.headers);
	if (access) headers.set(ACCESS_HEADER, access);
	const { pathname, search } = request.nextUrl;
	if (access || pathname === "/login") return NextResponse.next({ request: { headers } });
	if (pathname.startsWith("/api")) {
		return NextResponse.json({ error: "Log in to LearnHarness first." }, { status: 401, headers: { "Cache-Control": "no-store" } });
	}
	// An absolute URL on Next's own origin: Next rewrites it to a relative
	// Location, so a phone behind tailscale serve stays on the ts.net name.
	const login = new URL("/login", request.url);
	login.searchParams.set("next", pathname + search);
	return NextResponse.redirect(login, 303);
}

export const config = { matcher: "/((?!_next/).*)" };

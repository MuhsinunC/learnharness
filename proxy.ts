import { NextResponse, type NextRequest } from "next/server";
import { COMPUTER_ONLY_ERROR } from "./src/core/remote-access.ts";
import { computerOnlyRequest, desktopAPIAuthorized, desktopPageAuthorized, isDesktopServer } from "./src/server/desktop-access.ts";
import { ACCESS_HEADER, decideAccess, type Access } from "./src/server/web-login.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Web login (LH-43): the one place pages, API, SSE and attachments are
 * gated, in web mode and in the desktop app alike (trust rule:
 * src/server/web-login.ts). Requests that pass carry ACCESS_HEADER for the
 * routes that care; a client's own copy is always dropped first. */
export function proxy(request: NextRequest) {
	const headers = new Headers(request.headers);
	headers.delete(ACCESS_HEADER);
	const { pathname, search } = request.nextUrl;
	const api = pathname.startsWith("/api");
	let access: Access | null;
	if (isDesktopServer()) {
		// The window's per-launch secret: a header on its API calls, a cookie on
		// its page loads. Without it an API call needs a session, never "local".
		if (api ? desktopAPIAuthorized(request.headers) : desktopPageAuthorized(request.headers)) access = "desktop";
		else access = decideAccess(request.headers);
		if (api && access !== "desktop" && access !== "session") {
			return NextResponse.json(
				{ error: "Desktop API access requires the trusted LearnHarness window." },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
		if (access === "session" && computerOnlyRequest(request.method, pathname)) {
			return NextResponse.json({ error: COMPUTER_ONLY_ERROR, computerOnly: true }, { status: 403, headers: { "Cache-Control": "no-store" } });
		}
	} else {
		access = decideAccess(request.headers);
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

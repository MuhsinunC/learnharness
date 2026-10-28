import { NextResponse, type NextRequest } from "next/server";
import { computerOnlyMessage } from "./src/core/remote-access.ts";
import { computerOnlyRequest, desktopAPIAuthorized, desktopPageAuthorized, isDesktopServer, keyWriteRequest, routePath } from "./src/server/desktop-access.ts";
import { ACCESS_HEADER, confirmCurrentPassword, CURRENT_PASSWORD_HEADER, decideAccess, sameOriginRequest, type Access } from "./src/server/web-login.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Web login (LH-43): the one place pages, API, SSE and attachments are
 * gated, in web mode and in the desktop app alike (trust rule:
 * src/server/web-login.ts). Requests that pass carry ACCESS_HEADER for the
 * routes that care; a client's own copy is always dropped first. Every
 * route test reads routePath(), the one normalised spelling of the path. */
export function proxy(request: NextRequest) {
	const headers = new Headers(request.headers);
	headers.delete(ACCESS_HEADER);
	headers.delete(CURRENT_PASSWORD_HEADER);
	const { pathname, search } = request.nextUrl;
	const route = routePath(pathname);
	const api = route.startsWith("/api");
	// CSRF, in both modes and for every kind of access: a page on another
	// origin (another server on 127.0.0.1 is the same site, so the session
	// cookie goes along) cannot change anything. Origin, else
	// Sec-Fetch-Site decides; a client that sends neither (curl, the
	// desktop main process) is not a browser page and passes as before.
	if (api && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOriginRequest(request.headers)) {
		return NextResponse.json({ error: "Change LearnHarness only from its own pages." }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
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
	} else {
		access = decideAccess(request.headers);
	}
	// Sessions exist only once a password is set (web-login.ts), so this never
	// changes anything without one.
	if (access === "session" && computerOnlyRequest(request.method, route, isDesktopServer())) {
		return NextResponse.json({ error: computerOnlyMessage(isDesktopServer()), computerOnly: true }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	if (access) headers.set(ACCESS_HEADER, access);
	// Web mode, password set: a session swaps or deletes a key only with the
	// current password re-entered, so a stolen cookie alone cannot.
	if (access === "session" && !isDesktopServer() && keyWriteRequest(request.method, route)) {
		return confirmCurrentPassword(request.headers).then((result) => result.ok
			? NextResponse.next({ request: { headers } })
			: NextResponse.json(
				{ error: result.retryAfter ? "Too many failed attempts. Try again later." : "Enter the current remote-access password next to the key (Settings → Providers) to change it.", passwordRequired: true },
				{ status: result.retryAfter ? 429 : 403, headers: { "Cache-Control": "no-store", ...(result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {}) } },
			));
	}
	if (access || route === "/login" || publicAsset(request.method, pathname, route)) return NextResponse.next({ request: { headers } });
	if (api) {
		return NextResponse.json({ error: "Log in to LearnHarness first." }, { status: 401, headers: { "Cache-Control": "no-store" } });
	}
	// An absolute URL on Next's own origin: Next rewrites it to a relative
	// Location, so a phone behind tailscale serve stays on the ts.net name.
	const login = new URL("/login", request.url);
	login.searchParams.set("next", pathname + search);
	return NextResponse.redirect(login, 303);
}

/** The installable-app files (LH-46): browsers fetch the manifest and its
 * icons without cookies even when logged in, so the login wall lets these
 * through. GET and HEAD only, exact paths plus the /pwa/ folder, and only
 * in their plain spelling (the raw path already equals routePath()). */
function publicAsset(method: string, pathname: string, route: string): boolean {
	if ((method !== "GET" && method !== "HEAD") || pathname !== route) return false;
	return route === "/manifest.webmanifest" || route === "/apple-icon.png" || route.startsWith("/pwa/");
}

export const config = { matcher: "/((?!_next/).*)" };

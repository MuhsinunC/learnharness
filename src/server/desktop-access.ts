import { createHmac, timingSafeEqual } from "node:crypto";

/** The packaged desktop server (electron/main.cjs sets both). One predicate for
 * proxy.ts and the routes, so they never disagree about the mode. */
export function isDesktopServer(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_DESKTOP_SERVER === "1" || !!env.LH_DESKTOP_API_SECRET;
}

function matches(supplied: string | null | undefined, expected: string): boolean {
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function secret(env: Record<string, string | undefined>): string | null {
	const value = env.LH_DESKTOP_API_SECRET;
	return value && value.length >= 64 ? value : null;
}

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!isDesktopServer(env)) return true;
	const expected = secret(env);
	return expected !== null && matches(headers.get("x-learnharness-desktop"), expected);
}

/** The cookie electron/main.cjs sets for the window (HttpOnly, SameSite=Strict),
 * so its PAGE loads are trusted too once a remote-access password exists. An
 * HMAC of the secret: cookies ignore ports, so other local servers may see it,
 * and it must not unlock the API. API calls still need the header above. */
function desktopPageKey(env: Record<string, string | undefined> = process.env): string | null {
	const value = secret(env);
	return value && createHmac("sha256", value).update("lh-desktop-page").digest("hex");
}

export function desktopPageAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = isDesktopServer(env) ? desktopPageKey(env) : null;
	const cookie = (headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("lh_desktop="));
	return expected !== null && matches(cookie?.slice("lh_desktop=".length), expected);
}

/** Host-affecting routes (LH-43): once a remote-access password exists, a
 * logged-in browser session may not use them; only the desktop window
 * (its secret header) may. A stolen session cookie must not become a way
 * to run a binary, read a file, send credentials to a new endpoint or sign
 * in to an account on this computer.
 *   - /api/claude-code, /endpoint, /login: the executable path (runs it,
 *     GET included), the endpoint base URL and token, `claude auth login`.
 *   - /api/subscriptions, /browser: ChatGPT, Copilot and Grok sign-in (web mode).
 *   - POST /api/attachments/file: reads an image at a path on this computer.
 *   - /api/keys/* writes, in the desktop app only: there the window can do
 *     it. In web mode a password makes every browser a session, so key
 *     writes (a value, never a URL) stay open to sessions. */
export function computerOnlyRequest(method: string, rawPathname: string, desktop: boolean): boolean {
	// Match what the router matches: a percent-encoded name must not slip past.
	let pathname = rawPathname;
	try { pathname = decodeURIComponent(rawPathname); } catch { /* malformed: as sent */ }
	if (/^\/api\/(claude-code|subscriptions)(\/|$)/.test(pathname) || pathname === "/api/attachments/file") return true;
	return desktop && pathname.startsWith("/api/keys/") && method !== "GET" && method !== "HEAD";
}

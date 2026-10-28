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

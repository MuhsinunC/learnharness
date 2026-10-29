import { timingSafeEqual } from "node:crypto";
import { desktopPageKey } from "../../electron/desktop-api.cjs";

export { desktopPageKey };

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

/** The cookie electron/main.cjs sets for the window (HttpOnly, SameSite=Strict,
 * desktopPageKey), so its PAGE loads are trusted too: once a remote-access
 * password exists, and before one (LH-45), where a page load without it is
 * a browser that found this port and gets the login page (proxy.ts). Other
 * local servers may see it (cookies ignore ports), so it must not unlock
 * the API. API calls still need the header above. */
export function desktopPageAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const value = isDesktopServer(env) ? secret(env) : null;
	const expected = value && desktopPageKey(value);
	const cookie = (headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("lh_desktop="));
	return expected !== null && matches(cookie?.slice("lh_desktop=".length), expected);
}

/** How a logged-in browser session may use each API route (LH-43), keyed
 * by its folder under app/api. Once a remote-access password exists:
 *   - "session": a logged-in browser may use it.
 *   - "computer": it acts on this computer, so only the desktop window
 *     (its secret header) may. A stolen session cookie must not become a
 *     way to run a binary, read a file, send credentials to a new endpoint
 *     or sign in to an account here: the Claude Code executable path (run
 *     on GET too), endpoint and `claude auth login`; ChatGPT, Copilot and
 *     Grok sign-in; reading an image at a path (attachments/file).
 *   - "key-write": PUT/DELETE of an API key. In the desktop app only the
 *     window may. In web mode a password makes every browser a session,
 *     so a session writes a key (a value, never a URL) only with the
 *     current password re-entered (proxy.ts checks it).
 * Every route must be listed: web-login.e2e.ts fails on one that is not,
 * so a new route is classified before it ships, and proxy.ts refuses a
 * session any /api path that matches no entry. */
export const API_ROUTES = {
	"/api/activity": "session",
	"/api/activity/abort": "session",
	"/api/attachments": "session",
	"/api/attachments/[id]": "session",
	"/api/attachments/file": "computer",
	"/api/chat": "session",
	"/api/chats": "session",
	"/api/chats/[id]": "session",
	"/api/chats/[id]/artifact-ui": "session",
	"/api/chats/[id]/dismiss": "session",
	"/api/chats/[id]/markdown": "session",
	"/api/chats/[id]/repair": "session",
	"/api/chats/[id]/settings": "session",
	"/api/chats/[id]/steer": "session",
	"/api/chats/[id]/stream": "session",
	"/api/claude-code": "computer",
	"/api/claude-code/endpoint": "computer",
	"/api/claude-code/login": "computer",
	"/api/events": "session",
	"/api/graph": "session",
	"/api/graph/costs": "session",
	"/api/graph/coverage/extract": "session",
	"/api/graph/import": "session",
	"/api/graph/nodes/[id]": "session",
	"/api/graph/positions": "session",
	"/api/graph/render-settings": "session",
	"/api/graph/status": "session",
	"/api/jobs": "session",
	"/api/keys": "session",
	"/api/keys/[id]": "key-write",
	"/api/models": "session",
	"/api/remote-access": "session",
	"/api/search": "session",
	"/api/settings": "session",
	"/api/settings/[section]": "session",
	"/api/settings/context-windows": "session",
	"/api/settings/prompts": "session",
	"/api/settings/prompts/[...segment]": "session",
	"/api/stt/token": "session",
	"/api/subscriptions": "computer",
	"/api/subscriptions/browser": "computer",
} as const satisfies Record<string, "session" | "computer" | "key-write">;

export type APIRouteClass = (typeof API_ROUTES)[keyof typeof API_ROUTES];

const ROUTE_PATTERNS = Object.entries(API_ROUTES).map(([route, kind]) => ({
	kind,
	re: new RegExp(`^${route.replace(/\[\.\.\.[^\]]+\]/g, ".+").replace(/\[[^\]]+\]/g, "[^/]+")}$`),
}));
const STRICTNESS: Record<APIRouteClass, number> = { session: 0, "key-write": 1, computer: 2 };

/** The class of the route a routePath() reaches, or null for no route
 * (proxy.ts refuses those to a session). A path that fits several patterns
 * (attachments/file and attachments/[id]) gets the strictest, so router
 * precedence never matters. */
export function apiRouteClass(route: string): APIRouteClass | null {
	let found: APIRouteClass | null = null;
	for (const { kind, re } of ROUTE_PATTERNS) if (re.test(route) && (found === null || STRICTNESS[kind] > STRICTNESS[found])) found = kind;
	return found;
}

/** A request a session may not send once a password exists (API_ROUTES). */
export function computerOnlyRequest(method: string, kind: APIRouteClass | null, desktop: boolean): boolean {
	return kind === "computer" || (desktop && keyWriteRequest(method, kind));
}

export function keyWriteRequest(method: string, kind: APIRouteClass | null): boolean {
	return kind === "key-write" && method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/** The one spelling of a request path that proxy.ts tests: percent-decoded
 * until stable (a double encoding cannot hide a name), backslashes as
 * slashes, repeated slashes and dot segments resolved, no trailing slash,
 * lower case. Next 16.3.2's router did not route any encoded or
 * mixed-case spelling to an API route (LH-43 probe), so this is a margin:
 * a router that did would still meet the gate. */
export function routePath(pathname: string): string {
	let path = pathname;
	for (let i = 0; i < 4; i++) {
		let next: string;
		try { next = decodeURIComponent(path); } catch { break; }
		if (next === path) break;
		path = next;
	}
	const out: string[] = [];
	for (const segment of path.toLowerCase().replace(/\\/g, "/").split("/")) {
		if (segment === "..") out.pop();
		else if (segment !== "" && segment !== ".") out.push(segment);
	}
	return `/${out.join("/")}`;
}

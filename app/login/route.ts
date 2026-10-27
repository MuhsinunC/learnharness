/**
 * THE LOGIN PAGE (LH-43): plain HTML from a route handler, outside the app
 * layout, so it loads no client code and makes no API calls. The form
 * posts back here; success sets the session cookie and returns to `next`.
 * Failed attempts are rate-limited per client (and globally) BEFORE the
 * password is hashed. Every Location is relative: behind tailscale serve
 * an absolute one would point the phone at the laptop's loopback.
 */
import {
	ACCESS_HEADER,
	chargeLoginAttempt,
	clientKey,
	createSession,
	loginRetryAfter,
	passwordConfigured,
	safeNext,
	sessionCookie,
	verifyPassword,
} from "@/src/server";

export const dynamic = "force-dynamic";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, next: string, message: string | null, extra: Record<string, string> = {}): Response {
	const form = passwordConfigured()
		? `<form method="post" action="/login">
<input type="hidden" name="next" value="${escape(next)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Log in</button>
</form>`
		: `<p>Remote access is off. On the computer running LearnHarness, open Settings → General → Remote access and set a password.</p>`;
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in · Learning Harness</title>
<style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#141414;color:#e6e6e6;font:15px/1.5 ui-monospace,Menlo,monospace}
main{width:min(22rem,100% - 2rem)}h1{font-size:1rem;letter-spacing:.1em;text-transform:uppercase}
form{display:flex;flex-direction:column;gap:.5rem}input,button{font:inherit;padding:.6rem;border-radius:4px;border:1px solid #444;background:#1e1e1e;color:inherit}
button{cursor:pointer;background:#e6e6e6;color:#141414}p[role=alert]{color:#f87171}
</style></head><body><main><h1>Learning Harness</h1>
${message ? `<p role="alert">${escape(message)}</p>` : ""}${form}
</main></body></html>`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
			...extra,
		},
	});
}

const redirect = (location: string, extra: Record<string, string> = {}) =>
	new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });

export async function GET(req: Request): Promise<Response> {
	const next = safeNext(new URL(req.url).searchParams.get("next"));
	if (req.headers.get(ACCESS_HEADER)) return redirect(next);
	return page(200, next, null);
}

export async function POST(req: Request): Promise<Response> {
	const origin = req.headers.get("origin");
	if (origin !== null && origin !== "null") {
		const host = (() => { try { return new URL(origin).host; } catch { return null; } })();
		if (host !== req.headers.get("host")) return page(403, "/", "This login form must be sent from its own page.");
	}
	const form = await req.formData().catch(() => null);
	const next = safeNext(form?.get("next"));
	if (!passwordConfigured()) return page(403, next, null);
	const key = clientKey(req.headers);
	const wait = loginRetryAfter(key);
	if (wait > 0) return page(429, next, "Too many failed attempts. Try again later.", { "Retry-After": String(wait) });
	const release = chargeLoginAttempt(key);
	const password = form?.get("password");
	if (typeof password !== "string" || !password || !(await verifyPassword(password))) return page(401, next, "Wrong password.");
	release();
	return redirect(next, { "Set-Cookie": sessionCookie(createSession(), req.headers) });
}

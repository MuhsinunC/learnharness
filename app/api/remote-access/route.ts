/**
 * /api/remote-access (LH-43): the Settings → General "Remote access" row.
 *   GET    → {available, desktop, enabled, access, remotePort, restartNeeded, url}
 *   PUT    {password, current?} → sets or changes the password (revokes every session)
 *   DELETE {current?}           → turns remote access off (password and sessions go)
 * Who may write (trust rule: src/server/web-login.ts):
 *   - the desktop window (proxy.ts stamps "desktop" for its secret header);
 *   - a logged-in session that re-enters the current password (charged to
 *     that device's login rate limit, not the global cap).
 * A browser that is "local" only because no password exists yet can NOT set
 * the first one: that is the desktop window's or the CLI's job
 * (`npm run remote-access:set-password`), never plain HTTP.
 * remotePort is the port `tailscale serve` should point at. The desktop app
 * takes its fixed port (electron/main.cjs, LH_REMOTE_PORT) only at launch,
 * so right after the first password it reports restartNeeded.
 */
import { remotePasswordProblem } from "@/src/core";
import {
	ACCESS_HEADER,
	chargeLoginAttempt,
	clearPassword,
	clientKey,
	isDesktopServer,
	loginRetryAfter,
	passwordConfigured,
	remoteAccessAvailable,
	sameOriginRequest,
	setPassword,
	tailnetURL,
	verifyPassword,
} from "@/src/server";

export const dynamic = "force-dynamic";

const refuse = (error: string, status = 403) => Response.json({ error }, { status });

export async function GET(req: Request) {
	const access = req.headers.get(ACCESS_HEADER);
	const enabled = passwordConfigured();
	const port = Number(process.env.PORT) || null;
	const remotePort = isDesktopServer() ? Number(process.env.LH_REMOTE_PORT) || null : port;
	return Response.json({
		available: remoteAccessAvailable(),
		desktop: isDesktopServer(),
		enabled,
		access,
		remotePort,
		restartNeeded: enabled && remotePort !== port,
		url: enabled && (access === "desktop" || access === "session") ? await tailnetURL() : null,
	});
}

/** null when this request may change the password, else the refusal. */
async function writeRefusal(req: Request, body: { current?: unknown } | null): Promise<Response | null> {
	if (!remoteAccessAvailable()) return refuse("Remote access works only in the desktop app or with npm start.");
	if (!sameOriginRequest(req.headers)) return refuse("Change remote access from LearnHarness itself.");
	const access = req.headers.get(ACCESS_HEADER);
	if (access === "desktop") return null;
	if (access !== "session") {
		return refuse(isDesktopServer()
			? "Change remote access in the LearnHarness window."
			: "Set the first password on this computer with: npm run remote-access:set-password");
	}
	// This device's bucket only, as for key writes: the sender is logged in,
	// and failures charged to the global cap would lock every device out of /login.
	const key = clientKey(req.headers);
	const wait = loginRetryAfter(key, Date.now(), false);
	if (wait > 0) return Response.json({ error: "Too many failed attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(wait) } });
	const release = chargeLoginAttempt(key, Date.now(), false);
	if (typeof body?.current !== "string" || !(await verifyPassword(body.current))) return refuse("Enter the current password to change remote access.");
	release();
	return null;
}

export async function PUT(req: Request) {
	const body = (await req.json().catch(() => null)) as { password?: unknown; current?: unknown } | null;
	const refusal = await writeRefusal(req, body);
	if (refusal) return refusal;
	const problem = remotePasswordProblem(body?.password);
	if (problem) return refuse(problem, 400);
	await setPassword(body!.password as string);
	return Response.json({ enabled: true });
}

export async function DELETE(req: Request) {
	const body = (await req.json().catch(() => null)) as { current?: unknown } | null;
	const refusal = await writeRefusal(req, body);
	if (refusal) return refusal;
	clearPassword();
	return Response.json({ enabled: false });
}

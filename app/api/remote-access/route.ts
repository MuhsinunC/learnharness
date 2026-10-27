/**
 * /api/remote-access (LH-43): the Settings → General "Remote access" row.
 *   GET    → {enabled, access, remotePort, restartNeeded, url}
 *   PUT    {password} → sets or changes the password (revokes every session)
 *   DELETE → turns remote access off (password and sessions go)
 * Only a LOCAL request (proxy.ts's stamp: in the desktop app, the window's
 * secret header) may change it: a phone that logged in can use the app but
 * never take over or lock out the login.
 * remotePort is the port `tailscale serve` should point at. The desktop app
 * takes its fixed port (electron/main.cjs, LH_REMOTE_PORT) only at launch,
 * so right after the first password it reports restartNeeded.
 * A raw `next dev` (no LH_LISTEN_HOST from scripts/web-server.mjs) refuses
 * a new password: there the proxy could no longer trust this computer,
 * and the password could not be changed again without editing files.
 */
import { ACCESS_HEADER, MIN_PASSWORD_LENGTH, clearPassword, passwordConfigured, setPassword, tailnetURL } from "@/src/server";

export const dynamic = "force-dynamic";

const localOnly = () => Response.json({ error: "Change remote access on the computer running LearnHarness." }, { status: 403 });

export async function GET(req: Request) {
	const access = req.headers.get(ACCESS_HEADER);
	const enabled = passwordConfigured();
	const port = Number(process.env.PORT) || null;
	const remotePort = process.env.LH_DESKTOP_SERVER === "1" ? Number(process.env.LH_REMOTE_PORT) || null : port;
	return Response.json({
		enabled,
		access,
		remotePort,
		restartNeeded: enabled && remotePort !== port,
		// Only this computer learns the tailnet name; a phone already knows it.
		url: access === "local" && enabled ? await tailnetURL() : null,
	});
}

export async function PUT(req: Request) {
	if (req.headers.get(ACCESS_HEADER) !== "local") return localOnly();
	if (!process.env.LH_LISTEN_HOST) {
		return Response.json({ error: "Start LearnHarness with npm run dev or npm start to turn on remote access." }, { status: 409 });
	}
	const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
	const password = body?.password;
	if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 1024) {
		return Response.json({ error: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
	}
	await setPassword(password);
	return Response.json({ enabled: true });
}

export async function DELETE(req: Request) {
	if (req.headers.get(ACCESS_HEADER) !== "local") return localOnly();
	clearPassword();
	return Response.json({ enabled: false });
}

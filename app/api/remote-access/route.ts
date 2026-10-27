/**
 * /api/remote-access (LH-43): the Settings → General "Remote access" row.
 *   GET    → {available, enabled, access}
 *   PUT    {password} → sets or changes the password (revokes every session)
 *   DELETE → turns remote access off (password and sessions go)
 * Only a LOCAL request (proxy.ts's stamp) may change it: a phone that
 * logged in can use the app but never take over or lock out the login.
 * The desktop app has no fixed port to serve, so it reports unavailable.
 * A raw `next dev` (no LH_LISTEN_HOST from scripts/web-server.mjs) refuses
 * a new password: there the proxy could no longer trust this computer,
 * and the password could not be changed again without editing files.
 */
import { ACCESS_HEADER, MIN_PASSWORD_LENGTH, clearPassword, passwordConfigured, setPassword } from "@/src/server";

export const dynamic = "force-dynamic";

const desktop = () => process.env.LH_DESKTOP_SERVER === "1";
const localOnly = () => Response.json({ error: "Change remote access on the computer running LearnHarness." }, { status: 403 });

export async function GET(req: Request) {
	return Response.json({
		available: !desktop(),
		enabled: passwordConfigured(),
		access: req.headers.get(ACCESS_HEADER),
	});
}

export async function PUT(req: Request) {
	if (desktop() || req.headers.get(ACCESS_HEADER) !== "local") return localOnly();
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
	if (desktop() || req.headers.get(ACCESS_HEADER) !== "local") return localOnly();
	clearPassword();
	return Response.json({ enabled: false });
}

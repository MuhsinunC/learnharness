/** Remote access (LH-43): the password rules the Settings row and the server share. */
export const REMOTE_PASSWORD_MIN = 8;
export const REMOTE_PASSWORD_MAX = 1024;

export function remotePasswordProblem(password: unknown): string | null {
	if (typeof password !== "string" || password.length < REMOTE_PASSWORD_MIN) return `The password needs at least ${REMOTE_PASSWORD_MIN} characters.`;
	return password.length > REMOTE_PASSWORD_MAX ? `The password can have at most ${REMOTE_PASSWORD_MAX} characters.` : null;
}

/** What a logged-in browser gets for a host-affecting change once a password
 * exists (src/server/desktop-access.ts computerOnlyRequest): the desktop
 * window may make it; in web mode, the computer turns remote access off first. */
export function computerOnlyMessage(desktop: boolean): string {
	return desktop
		? "Change this in the LearnHarness desktop app on the computer."
		: "Change this on the computer: run npm run remote-access:off, change it here, then set the password again.";
}

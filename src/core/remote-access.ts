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

/** proxy.ts's refusal of a typed image path to a logged-in browser
 * (LH-45): the file is on the computer, which only its own window or
 * browser reads (attachments/file is computer-only), so it points at the
 * composer's image picker instead. */
export const PATH_COMPUTER_ONLY = "Images can't be attached by path from this browser. Use the image button instead.";

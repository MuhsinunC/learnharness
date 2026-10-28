/** Remote access (LH-43): the password rules the Settings row and the server share. */
export const REMOTE_PASSWORD_MIN = 8;
export const REMOTE_PASSWORD_MAX = 1024;

export function remotePasswordProblem(password: unknown): string | null {
	if (typeof password !== "string" || password.length < REMOTE_PASSWORD_MIN) return `The password needs at least ${REMOTE_PASSWORD_MIN} characters.`;
	return password.length > REMOTE_PASSWORD_MAX ? `The password can have at most ${REMOTE_PASSWORD_MAX} characters.` : null;
}

/**
 * Server-side password policy shared by every code path that sets a new
 * password (signup and password-reset confirmation). The browser UI hints the
 * same minimum, but the server is the trust boundary: never rely on the client
 * to enforce password strength.
 */
export const minPasswordLength = 8
// Upper bound keeps unbounded input out of PBKDF2 (100k iterations), which
// would otherwise let a caller inflate per-request CPU cost with huge strings.
export const maxPasswordLength = 128

export function getPasswordPolicyError(password: string): string | null {
	if (password.length < minPasswordLength) {
		return `Password must be at least ${minPasswordLength} characters.`
	}
	if (password.length > maxPasswordLength) {
		return `Password must be at most ${maxPasswordLength} characters.`
	}
	return null
}

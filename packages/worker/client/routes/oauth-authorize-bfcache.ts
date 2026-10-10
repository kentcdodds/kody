/**
 * Provider/passkey start leaves `signInStatus` at `submitting` through
 * `location.assign`. A bfcache Back restores that page with controls disabled;
 * pageshow with `persisted` is the signal to re-enable them (and callers should
 * also reset Turnstile — the spent token is still in the restored widget).
 */
export function resolveSignInStatusAfterPageshow(
	persisted: boolean,
	signInStatus: 'idle' | 'submitting',
): 'idle' | 'submitting' {
	return persisted && signInStatus === 'submitting' ? 'idle' : signInStatus
}

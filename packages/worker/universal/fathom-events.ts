/**
 * Shared Fathom event names and post-signup query signal. The browser helper
 * that calls `window.fathom.trackEvent` lives in `#client/fathom-events.ts`.
 */

export const fathomEventNames = {
	signupStarted: 'signup_started',
	accountCreated: 'account_created',
} as const

export type FathomEventName =
	(typeof fathomEventNames)[keyof typeof fathomEventNames]

export const accountCreatedQueryParam = 'accountCreated'

/** Appended to post-OAuth-signup redirects so the client can fire account_created. */
export function withAccountCreatedQuery(path: string): string {
	try {
		const url = new URL(path, 'https://kody.codes')
		url.searchParams.set(accountCreatedQueryParam, '1')
		return `${url.pathname}${url.search}${url.hash}`
	} catch {
		const join = path.includes('?') ? '&' : '?'
		return `${path}${join}${accountCreatedQueryParam}=1`
	}
}

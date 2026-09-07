import { routes } from './routes.ts'
import { type SignupMode } from './signup-mode.ts'

/**
 * Shared public signup destinations and CTA labels. Marketing pages (home,
 * pricing, FAQ, blog closer) consume these so invite / open / waitlist copy
 * stays consistent. Legal privacy/terms wording is owned separately.
 */
export const publicWaitlistHref = `${routes.home.href()}#invite`
export const publicSignupHref = routes.signup.href()
export const publicInviteSignupHref = `${routes.signup.href()}?panel=invite`
export const publicWaitlistSignupHref = `${routes.signup.href()}?panel=waiting-list`

export const publicCreateAccountLabel = 'Create a free account'
export const publicJoinWaitlistLabel = 'Join the waiting list'
export const publicHaveCodeLabel = 'I have a code'

export type PublicSignupCta = {
	href: string
	label: string
}

export function publicSignupPrimaryCta(mode: SignupMode): PublicSignupCta {
	switch (mode) {
		case 'open':
			return { href: publicSignupHref, label: publicCreateAccountLabel }
		case 'invite':
		case 'waitlist':
			return { href: publicWaitlistHref, label: publicJoinWaitlistLabel }
		default: {
			const exhaustive: never = mode
			return exhaustive
		}
	}
}

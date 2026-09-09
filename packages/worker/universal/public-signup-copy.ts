import { routes } from './routes.ts'

/**
 * Shared public signup destinations and CTA labels. Marketing pages (home,
 * pricing, FAQ, blog closer) consume these so signed-out copy stays
 * consistent. Legal privacy/terms wording is owned separately.
 */
export const publicSignupHref = routes.signup.href()

export const publicCreateAccountLabel = 'Create a free account'

export type PublicSignupCta = {
	href: string
	label: string
}

export function publicSignupPrimaryCta(): PublicSignupCta {
	return { href: publicSignupHref, label: publicCreateAccountLabel }
}

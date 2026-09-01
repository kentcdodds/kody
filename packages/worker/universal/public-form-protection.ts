/**
 * Hidden trap field on public auth forms. The name must not match HTML
 * autocomplete tokens (`website`, `url`, `email`, …) or password-manager
 * login fields — those get filled for real users and then fail closed with
 * a generic error.
 */
export const honeypotFieldName = 'kody_hp' as const
export const turnstileResponseFieldName = 'turnstileToken' as const

export type PublicFormProtectionFields = {
	[honeypotFieldName]: string
	[turnstileResponseFieldName]: string
}

export function emptyPublicFormProtection(): PublicFormProtectionFields {
	return {
		[honeypotFieldName]: '',
		[turnstileResponseFieldName]: '',
	}
}

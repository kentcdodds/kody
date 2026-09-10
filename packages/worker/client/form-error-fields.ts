export type AuthInvalidField = 'username' | 'email' | 'password'

const noInvalidFields = new Set<AuthInvalidField>()

export function invalidFieldsForMessage(
	status: string,
	message: string | null,
	fallback: ReadonlyArray<AuthInvalidField>,
): Set<AuthInvalidField> {
	if (status !== 'error' || !message) return noInvalidFields
	const text = message.toLowerCase()
	if (/\busername\b/.test(text)) return new Set(['username'])
	if (/\bemail\b/.test(text) && !/\bpassword\b/.test(text)) {
		return new Set(['email'])
	}
	if (/\bpassword\b/.test(text) && !/\bemail\b/.test(text)) {
		return new Set(['password'])
	}
	return new Set(fallback)
}

export function fieldErrorProps(
	field: AuthInvalidField,
	invalidFields: Set<AuthInvalidField>,
	describedById: string,
) {
	if (!invalidFields.has(field)) return {}
	return {
		'aria-invalid': 'true' as const,
		'aria-describedby': describedById,
	}
}

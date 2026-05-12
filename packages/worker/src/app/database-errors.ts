export function getUniqueConstraintField(error: unknown) {
	let currentError = error
	while (currentError instanceof Error) {
		const match = /unique constraint failed:\s*[^.]+\.([a-z_]+)/i.exec(
			currentError.message,
		)
		if (match?.[1]) {
			return match[1].toLowerCase()
		}
		currentError = currentError.cause
	}
	return null
}

export function isUniqueConstraintError(error: unknown) {
	return getUniqueConstraintField(error) !== null
}

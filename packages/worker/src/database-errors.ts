const uniqueIndexFieldNames: Record<string, string> = {
	idx_users_stable_user_id: 'stable_user_id',
}

export function getUniqueConstraintField(error: unknown) {
	let currentError = error
	while (currentError instanceof Error) {
		const tableColumnMatch =
			/unique constraint failed:\s*[^.]+\.([a-z0-9_]+)/i.exec(
				currentError.message,
			)
		if (tableColumnMatch?.[1]) {
			return tableColumnMatch[1].toLowerCase()
		}
		const indexMatch = /unique constraint failed:\s*(idx_[a-z0-9_]+)/i.exec(
			currentError.message,
		)
		const indexName = indexMatch?.[1]?.toLowerCase()
		if (indexName) {
			return uniqueIndexFieldNames[indexName] ?? indexName
		}
		currentError = currentError.cause
	}
	return null
}

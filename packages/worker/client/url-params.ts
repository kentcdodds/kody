export function readTrimmedParam(params: URLSearchParams, key: string) {
	const value = params.get(key)
	return value?.trim() ? value.trim() : null
}

export function readCommaListParams(
	params: URLSearchParams,
	keys: Array<string>,
) {
	return keys.flatMap((key) =>
		params
			.getAll(key)
			.flatMap((value) => value.split(','))
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
	)
}

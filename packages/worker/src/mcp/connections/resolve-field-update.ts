export function resolveFieldUpdate<
	TFields extends Record<string, unknown>,
	TKey extends keyof TFields,
>(fields: TFields, key: TKey, currentValue: TFields[TKey]) {
	return Object.hasOwn(fields, key) && fields[key] !== undefined
		? fields[key]
		: currentValue
}

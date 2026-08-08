import { isRecord } from '@kody-internal/shared/is-record.ts'

export const redactedSecretText = '[REDACTED SECRET]'

export type ExecutionSecretRedactor = {
	track(value: string): void
	redactErrorMessage(value: string): string
	redactUnknown(value: unknown): unknown
}

export function createExecutionSecretRedactor(): ExecutionSecretRedactor {
	const secretValues = new Set<string>()
	return {
		track(value: string) {
			if (value.length > 0) {
				secretValues.add(value)
			}
		},
		redactErrorMessage(value: string) {
			return redactSecretValuesInString(value, secretValues)
		},
		redactUnknown(value: unknown) {
			return redactUnknownSecretValues(value, secretValues)
		},
	}
}

function redactUnknownSecretValues(
	value: unknown,
	secretValues: ReadonlySet<string>,
	seen = new WeakMap<object, unknown>(),
): unknown {
	if (secretValues.size === 0) return value
	if (typeof value === 'string') {
		return redactSecretValuesInString(value, secretValues)
	}
	if (value instanceof Error) {
		const existing = seen.get(value)
		if (existing) return existing
		const next = new Error(
			redactSecretValuesInString(value.message, secretValues),
			value.cause !== undefined ? { cause: undefined } : undefined,
		)
		seen.set(value, next)
		if (value.cause !== undefined) {
			next.cause = redactUnknownSecretValues(value.cause, secretValues, seen)
		}
		next.name = value.name
		if (value.stack) {
			next.stack = redactSecretValuesInString(value.stack, secretValues)
		}
		return next
	}
	if (Array.isArray(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Array<unknown> = []
		seen.set(value, next)
		for (const entry of value) {
			next.push(redactUnknownSecretValues(entry, secretValues, seen))
		}
		return next
	}
	if (isRecord(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Record<string, unknown> = {}
		seen.set(value, next)
		for (const [key, entry] of Object.entries(value)) {
			const redactedKey = redactSecretValuesInString(key, secretValues)
			next[redactedKey] = redactUnknownSecretValues(entry, secretValues, seen)
		}
		return next
	}
	return value
}

function redactSecretValuesInString(
	value: string,
	secretValues: ReadonlySet<string>,
) {
	if (secretValues.size === 0 || value.length === 0) return value
	let nextValue = value
	for (const secretValue of [...secretValues].sort(
		(left, right) => right.length - left.length,
	)) {
		nextValue = nextValue.replaceAll(secretValue, redactedSecretText)
	}
	return nextValue
}

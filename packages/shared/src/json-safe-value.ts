import { getErrorMessage } from './error-message.ts'

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| Array<JsonValue>
	| { [key: string]: JsonValue }

/**
 * Coerce a value to plain JSON via a stringify round trip (dropping
 * functions, symbols, and undefined members), falling back to the error
 * message for values that cannot be serialized at all.
 */
export function toJsonSafeValue(value: unknown): JsonValue {
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue
	} catch {
		return getErrorMessage(value)
	}
}

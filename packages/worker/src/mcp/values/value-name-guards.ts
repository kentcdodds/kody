import { skillRunnerTokensValueName } from './skill-runner-tokens.ts'

const reservedValueNames = new Set([skillRunnerTokensValueName])

export function isReservedValueName(name: string) {
	return reservedValueNames.has(name)
}

export function assertValueNameAllowed(name: string) {
	if (isReservedValueName(name)) {
		throw new Error('Value name is reserved for internal use.')
	}
}

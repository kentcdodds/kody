const reservedSecretNames = new Set<string>()

export function isReservedSecretName(name: string) {
	return reservedSecretNames.has(name)
}

export function assertSecretNameAllowed(name: string) {
	if (isReservedSecretName(name)) {
		throw new Error('Secret name is reserved for internal use.')
	}
}

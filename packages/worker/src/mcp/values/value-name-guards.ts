const reservedValueNames = new Set<string>()

const platformReservedValuePrefixes = ['_integration:', '_openapi:'] as const

const platformReservedValuePrefixCapabilities = {
	'_integration:': 'integration_save',
	'_openapi:': 'openapi_binding_save',
} as const satisfies Record<
	(typeof platformReservedValuePrefixes)[number],
	string
>

export function isReservedValueName(name: string) {
	return reservedValueNames.has(name)
}

export function isPlatformReservedValueName(name: string) {
	return platformReservedValuePrefixes.some((prefix) => name.startsWith(prefix))
}

export function assertValueNameAllowed(name: string) {
	if (isReservedValueName(name)) {
		throw new Error('Value name is reserved for internal use.')
	}
}

export function assertAgentWritableValueName(name: string) {
	assertValueNameAllowed(name)
	for (const prefix of platformReservedValuePrefixes) {
		if (!name.startsWith(prefix)) continue
		const capability = platformReservedValuePrefixCapabilities[prefix]
		throw new Error(
			`Value names with the ${prefix} prefix are managed by the ${capability} capability. Use ${capability} instead of value_set.`,
		)
	}
}

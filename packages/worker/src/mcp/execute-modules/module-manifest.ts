export const codemodeModuleCapabilityManifest = {
	'@kody/codemode-utils': ['connector_get', 'value_get'],
} as const satisfies Record<string, ReadonlyArray<string>>
export function getCodemodeModuleCapabilities(specifier: string) {
	if (specifier in codemodeModuleCapabilityManifest) {
		return codemodeModuleCapabilityManifest[
			specifier as keyof typeof codemodeModuleCapabilityManifest
		]
	}
	return []
}

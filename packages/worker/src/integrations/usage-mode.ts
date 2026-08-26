export const integrationUsageModeValues = ['any', 'packages'] as const

export type IntegrationUsageMode = (typeof integrationUsageModeValues)[number]

export function isIntegrationUsageMode(
	value: string | null | undefined,
): value is IntegrationUsageMode {
	return value === 'any' || value === 'packages'
}

export function normalizeIntegrationUsageMode(
	value: string | null | undefined,
): IntegrationUsageMode {
	return isIntegrationUsageMode(value) ? value : 'any'
}

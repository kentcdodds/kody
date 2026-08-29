export const mcpServerUsageModeValues = ['any', 'packages'] as const

export type McpServerUsageMode = (typeof mcpServerUsageModeValues)[number]

export function isMcpServerUsageMode(
	value: string | null | undefined,
): value is McpServerUsageMode {
	return value === 'any' || value === 'packages'
}

export function normalizeMcpServerUsageMode(
	value: string | null | undefined,
): McpServerUsageMode {
	return isMcpServerUsageMode(value) ? value : 'any'
}

import { z } from 'zod'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

export const connectorFlowValues = ['pkce', 'confidential'] as const

export const connectorConfigSchema = z.object({
	name: z.string().min(1),
	tokenUrl: z.string().url(),
	flow: z.enum(connectorFlowValues),
	clientIdValueName: z.string().min(1),
	clientSecretSecretName: z.string().min(1).optional().nullable(),
	accessTokenSecretName: z.string().min(1),
	refreshTokenSecretName: z.string().min(1).optional().nullable(),
	requiredHosts: z.array(z.string()).optional(),
})

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>

export function normalizeConnectorConfig(
	value: ConnectorConfig,
): ConnectorConfig {
	return {
		...value,
		name: value.name.trim(),
		tokenUrl: value.tokenUrl.trim(),
		clientIdValueName: value.clientIdValueName.trim(),
		clientSecretSecretName: value.clientSecretSecretName?.trim() || null,
		accessTokenSecretName: value.accessTokenSecretName.trim(),
		refreshTokenSecretName: value.refreshTokenSecretName?.trim() || null,
		requiredHosts: normalizeAllowedHosts(value.requiredHosts ?? []),
	}
}

const connectorValuePrefix = '_connector:'

export function buildConnectorValueName(name: string) {
	return `${connectorValuePrefix}${name}`
}

export function parseConnectorValueName(name: string) {
	if (!name.startsWith(connectorValuePrefix)) return null
	const connectorName = name.slice(connectorValuePrefix.length).trim()
	return connectorName.length > 0 ? connectorName : null
}

export function parseConnectorConfig(
	value: unknown,
	fallbackName: string | null,
) {
	const record =
		value && typeof value === 'object' && !Array.isArray(value)
			? value
			: null
	const configCandidate =
		record && typeof (record as Record<string, unknown>).name === 'string'
			? record
			: record && fallbackName
				? { ...record, name: fallbackName }
				: record
	const parsed = connectorConfigSchema.safeParse(configCandidate)
	return parsed.success ? normalizeConnectorConfig(parsed.data) : null
}

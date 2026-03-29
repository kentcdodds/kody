import { z } from 'zod'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

export const connectorFlowValues = ['pkce', 'confidential'] as const

export const connectorConfigSchema = z.object({
	name: z.string().min(1),
	tokenUrl: z.string().url(),
	apiBaseUrl: z.string().url().optional().nullable(),
	flow: z.enum(connectorFlowValues),
	clientIdValueName: z.string().min(1),
	clientSecretSecretName: z.string().min(1).optional().nullable(),
	accessTokenSecretName: z.string().min(1),
	refreshTokenSecretName: z.string().min(1).optional().nullable(),
	requiredHosts: z.array(z.string()).optional(),
})

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>

export const connectorSaveSchema = z
	.object({
		name: z.string().min(1),
		tokenUrl: z.string().url().optional(),
		apiBaseUrl: z.string().url().nullable().optional(),
		flow: z.enum(connectorFlowValues).optional(),
		clientIdValueName: z.string().min(1).optional(),
		clientSecretSecretName: z.string().min(1).nullable().optional(),
		accessTokenSecretName: z.string().min(1).optional(),
		refreshTokenSecretName: z.string().min(1).nullable().optional(),
		requiredHosts: z.array(z.string()).optional(),
	})
	.strict()

export type ConnectorSave = z.infer<typeof connectorSaveSchema>

export function normalizeConnectorConfig(
	value: ConnectorConfig,
): ConnectorConfig {
	return {
		...value,
		name: value.name.trim(),
		tokenUrl: value.tokenUrl.trim(),
		apiBaseUrl: value.apiBaseUrl?.trim() || null,
		clientIdValueName: value.clientIdValueName.trim(),
		clientSecretSecretName: value.clientSecretSecretName?.trim() || null,
		accessTokenSecretName: value.accessTokenSecretName.trim(),
		refreshTokenSecretName: value.refreshTokenSecretName?.trim() || null,
		requiredHosts: normalizeAllowedHosts(value.requiredHosts ?? []),
	}
}

export function mergeConnectorConfig(
	current: ConnectorConfig,
	update: ConnectorSave,
): ConnectorConfig {
	return normalizeConnectorConfig({
		...current,
		...update,
		name: update.name.trim(),
	})
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
		value && typeof value === 'object' && !Array.isArray(value) ? value : null
	const configCandidate =
		record && typeof (record as Record<string, unknown>).name === 'string'
			? record
			: record && fallbackName
				? { ...record, name: fallbackName }
				: record
	const parsed = connectorConfigSchema.safeParse(configCandidate)
	return parsed.success ? normalizeConnectorConfig(parsed.data) : null
}

export function parseConnectorJson(raw: string) {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

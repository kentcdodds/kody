import { z } from 'zod'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

export const integrationFlowValues = ['pkce', 'confidential'] as const

export const integrationConfigSchema = z.object({
	name: z.string().min(1),
	tokenUrl: z.string().url(),
	apiBaseUrl: z.string().url().optional().nullable(),
	flow: z.enum(integrationFlowValues),
	clientIdValueName: z.string().min(1),
	clientSecretSecretName: z.string().min(1).optional().nullable(),
	accessTokenSecretName: z.string().min(1),
	refreshTokenSecretName: z.string().min(1).optional().nullable(),
	requiredHosts: z.array(z.string()).optional(),
})

export type IntegrationConfig = z.infer<typeof integrationConfigSchema>

export const integrationSaveSchema = z
	.object({
		name: z.string().min(1),
		tokenUrl: z.string().url().optional(),
		apiBaseUrl: z.string().url().nullable().optional(),
		flow: z.enum(integrationFlowValues).optional(),
		clientIdValueName: z.string().min(1).optional(),
		clientSecretSecretName: z.string().min(1).nullable().optional(),
		accessTokenSecretName: z.string().min(1).optional(),
		refreshTokenSecretName: z.string().min(1).nullable().optional(),
		requiredHosts: z.array(z.string()).optional(),
	})
	.strict()

export type IntegrationSaveInput = z.infer<typeof integrationSaveSchema>

export function normalizeIntegrationConfig(
	value: IntegrationConfig,
): IntegrationConfig {
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

export function mergeIntegrationConfig(
	current: IntegrationConfig,
	update: IntegrationSaveInput,
): IntegrationConfig {
	return normalizeIntegrationConfig({
		...current,
		...update,
		name: update.name,
	})
}

const integrationValuePrefix = '_integration:'

export function buildIntegrationValueName(name: string) {
	return `${integrationValuePrefix}${name}`
}

export function parseIntegrationValueName(name: string) {
	if (!name.startsWith(integrationValuePrefix)) return null
	const integrationName = name.slice(integrationValuePrefix.length).trim()
	return integrationName.length > 0 ? integrationName : null
}

export function parseIntegrationConfig(
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
	const parsed = integrationConfigSchema.safeParse(configCandidate)
	return parsed.success ? normalizeIntegrationConfig(parsed.data) : null
}

export function parseIntegrationJson(raw: string) {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

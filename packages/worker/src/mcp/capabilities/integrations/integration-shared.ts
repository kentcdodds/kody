import { z } from 'zod'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

export const integrationFlowValues = ['pkce', 'confidential'] as const

const defaultIntegrationScopeSeparator = ' '

export const tokenExchangeStyleValues = ['form', 'basic-json'] as const

export const integrationAuthorizationSchema = z
	.object({
		authorizeUrl: z.string().url().refine(isHttpUrl, {
			message: 'Authorize URL must use http or https.',
		}),
		scopes: z.array(
			z
				.string()
				.min(1)
				.refine((scope) => scope.trim().length > 0, {
					message: 'Scope cannot be whitespace-only.',
				}),
		),
		scopeSeparator: z.string().min(1).optional().nullable(),
		extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
	})
	.strict()

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
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).optional().nullable(),
	authorization: integrationAuthorizationSchema.optional().nullable(),
})

export type IntegrationConfig = z.infer<typeof integrationConfigSchema>
type IntegrationAuthorization = z.infer<typeof integrationAuthorizationSchema>

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
		tokenExchangeStyle: z.enum(tokenExchangeStyleValues).nullable().optional(),
		authorization: integrationAuthorizationSchema.nullable().optional(),
	})
	.strict()

export type IntegrationSaveInput = z.infer<typeof integrationSaveSchema>

export function normalizeIntegrationConfig(
	value: IntegrationConfig,
): IntegrationConfig {
	const authorization = value.authorization
		? normalizeIntegrationAuthorization(value.authorization)
		: null
	const tokenExchangeStyle = value.tokenExchangeStyle ?? null
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
		...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
		...(authorization ? { authorization } : {}),
	}
}

function normalizeIntegrationAuthorization(
	value: IntegrationAuthorization,
): IntegrationAuthorization {
	const scopeSeparator =
		value.scopeSeparator == null ||
		value.scopeSeparator === defaultIntegrationScopeSeparator
			? null
			: value.scopeSeparator
	const extraAuthorizeParams: Record<string, string> = {}
	for (const [rawKey, paramValue] of Object.entries(
		value.extraAuthorizeParams ?? {},
	)) {
		const key = rawKey.trim()
		if (key) extraAuthorizeParams[key] = paramValue
	}
	return {
		authorizeUrl: value.authorizeUrl.trim(),
		scopes: value.scopes.map((scope) => scope.trim()).filter(Boolean),
		scopeSeparator,
		extraAuthorizeParams: Object.fromEntries(
			Object.keys(extraAuthorizeParams)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, extraAuthorizeParams[key] ?? '']),
		),
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
	if (parsed.success) return normalizeIntegrationConfig(parsed.data)
	return null
}

export function parseIntegrationJson(raw: string) {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

function isHttpUrl(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

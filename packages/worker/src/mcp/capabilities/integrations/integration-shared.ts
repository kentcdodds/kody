import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { z } from 'zod'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

export const integrationFlowValues = ['pkce', 'confidential'] as const

/**
 * Integration identity is the canonical provider key (lowercase kebab via
 * normalizeProviderKey). Every read and write path derives names and value
 * keys through this one function, so lookups never depend on how a caller
 * cased or spaced the provider name.
 */
export function canonicalIntegrationName(name: string) {
	return normalizeProviderKey(name)
}

const integrationNameSchema = z
	.string()
	.min(1)
	.refine((name) => /[a-z0-9]/.test(canonicalIntegrationName(name)), {
		message: 'Integration name must contain letters or numbers.',
	})

const defaultIntegrationScopeSeparator = ' '

export const tokenExchangeStyleValues = [
	'form',
	'basic-json',
	'basic-form',
] as const

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
	name: integrationNameSchema,
	tokenUrl: z.string().url(),
	apiBaseUrl: z.string().url().optional().nullable(),
	flow: z.enum(integrationFlowValues),
	/**
	 * PKCE is orthogonal to `flow`. Absent means the flow default: PKCE on for
	 * `pkce` flow, off for `confidential`. Canva-style providers store
	 * `usePkce: true` with `confidential` flow.
	 */
	usePkce: z.boolean().optional().nullable(),
	clientId: z.string().min(1),
	clientSecretSecretName: z.string().min(1).optional().nullable(),
	accessTokenSecretName: z.string().min(1),
	refreshTokenSecretName: z.string().min(1).optional().nullable(),
	requiredHosts: z.array(z.string()).optional(),
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).optional().nullable(),
	authorization: integrationAuthorizationSchema.optional().nullable(),
	/**
	 * True when the connection uses a platform (built-in) OAuth app. Platform
	 * connections never expose a client secret name: the shared secret lives
	 * encrypted outside the user secret store and token exchange runs
	 * host-side (`integration_token_refresh`).
	 */
	platform: z.boolean().optional(),
})

export type IntegrationConfig = z.infer<typeof integrationConfigSchema>
type IntegrationAuthorization = z.infer<typeof integrationAuthorizationSchema>

export const integrationSaveSchema = z
	.object({
		name: integrationNameSchema,
		tokenUrl: z.string().url().optional(),
		apiBaseUrl: z.string().url().nullable().optional(),
		flow: z.enum(integrationFlowValues).optional(),
		usePkce: z.boolean().nullable().optional(),
		clientId: z.string().min(1).optional(),
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
	const normalized = normalizeIntegrationConfigFields(value)
	return {
		...normalized,
		clientId: value.clientId.trim(),
	}
}

function normalizeIntegrationConfigFields(
	value: Pick<
		IntegrationConfig,
		| 'name'
		| 'tokenUrl'
		| 'apiBaseUrl'
		| 'flow'
		| 'usePkce'
		| 'clientSecretSecretName'
		| 'accessTokenSecretName'
		| 'refreshTokenSecretName'
		| 'requiredHosts'
		| 'tokenExchangeStyle'
		| 'authorization'
	>,
) {
	const authorization = value.authorization
		? normalizeIntegrationAuthorization(value.authorization)
		: null
	const tokenExchangeStyle = value.tokenExchangeStyle ?? null
	// Store usePkce only when it differs from the flow default so existing
	// integration records keep their canonical shape.
	const usePkce =
		typeof value.usePkce === 'boolean' &&
		value.usePkce !== (value.flow === 'pkce')
			? value.usePkce
			: null
	return {
		name: canonicalIntegrationName(value.name),
		tokenUrl: value.tokenUrl.trim(),
		apiBaseUrl: value.apiBaseUrl?.trim() || null,
		flow: value.flow,
		...(usePkce == null ? {} : { usePkce }),
		clientSecretSecretName: value.clientSecretSecretName?.trim() || null,
		accessTokenSecretName: value.accessTokenSecretName.trim(),
		refreshTokenSecretName: value.refreshTokenSecretName?.trim() || null,
		requiredHosts: normalizeAllowedHosts(value.requiredHosts ?? []),
		...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
		...(authorization ? { authorization } : {}),
	}
}

export function normalizeIntegrationAuthorization(
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

function isHttpUrl(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

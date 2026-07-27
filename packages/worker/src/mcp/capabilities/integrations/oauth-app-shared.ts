import { z } from 'zod'
import {
	type UserOauthApp,
	type UserOauthAppWithConnectionCount,
} from '#worker/integrations/types.ts'
import {
	integrationFlowValues,
	tokenExchangeStyleValues,
} from './integration-shared.ts'

/**
 * Public OAuth-app projection for MCP capabilities.
 * Never includes client secret / token values — only secret *names*.
 */
export const oauthAppConnectionRefSchema = z.object({
	name: z.string().min(1),
	accountLabel: z.string().nullable(),
})

export const oauthAppPublicSchema = z.object({
	slug: z.string().min(1),
	provider: z.string().min(1),
	label: z.string().nullable(),
	clientId: z.string().min(1),
	clientSecretSecretName: z.string().nullable(),
	tokenUrl: z.string().url(),
	authorizeUrl: z.string().url().nullable(),
	apiBaseUrl: z.string().url().nullable(),
	flow: z.enum(integrationFlowValues),
	usePkce: z.boolean().nullable(),
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).nullable(),
	scopeSeparator: z.string().nullable(),
	extraAuthorizeParams: z.record(z.string(), z.string()),
	connectionCount: z.number().int().nonnegative(),
	connections: z.array(oauthAppConnectionRefSchema),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type OauthAppPublic = z.infer<typeof oauthAppPublicSchema>

export function toOauthAppPublic(
	app: UserOauthApp | UserOauthAppWithConnectionCount,
	connections: Array<{ name: string; accountLabel: string | null }>,
): OauthAppPublic {
	const connectionCount =
		'connectionCount' in app ? app.connectionCount : connections.length
	return {
		slug: app.slug,
		provider: app.provider,
		label: app.label,
		clientId: app.clientId,
		clientSecretSecretName: app.clientSecretSecretName,
		tokenUrl: app.tokenUrl,
		authorizeUrl: app.authorizeUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		tokenExchangeStyle: app.tokenExchangeStyle,
		scopeSeparator: app.scopeSeparator,
		extraAuthorizeParams: app.extraAuthorizeParams,
		connectionCount,
		connections,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}

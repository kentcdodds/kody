import { z } from 'zod'
import {
	integrationFlowValues,
	tokenExchangeStyleValues,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { type PlatformOauthApp } from './platform-apps.ts'
export const oauthAppFlowSchema = z.enum(integrationFlowValues)
export const oauthTokenExchangeStyleSchema = z.enum(tokenExchangeStyleValues)

export const userOauthAppSchema = z.object({
	userId: z.string().min(1),
	slug: z.string().min(1),
	provider: z.string().min(1),
	label: z.string().min(1).nullable(),
	clientId: z.string().min(1),
	clientSecretSecretName: z.string().min(1).nullable(),
	tokenUrl: z.string().url(),
	authorizeUrl: z.string().url().nullable(),
	apiBaseUrl: z.string().url().nullable(),
	flow: oauthAppFlowSchema,
	usePkce: z.boolean().nullable(),
	tokenExchangeStyle: oauthTokenExchangeStyleSchema.nullable(),
	scopeSeparator: z.string().min(1).nullable(),
	extraAuthorizeParams: z.record(z.string(), z.string()),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type UserOauthApp = z.infer<typeof userOauthAppSchema>

export const userIntegrationConnectionSchema = z.object({
	userId: z.string().min(1),
	name: z.string().min(1),
	/** User-owned OAuth app slug; null for platform-app connections. */
	appSlug: z.string().min(1).nullable(),
	/** Platform (built-in) app slug; null for user-owned app connections. */
	platformAppSlug: z.string().min(1).nullable(),
	accountLabel: z.string().min(1).nullable(),
	description: z.string(),
	scopes: z.array(z.string()),
	requiredHosts: z.array(z.string()),
	accessTokenSecretName: z.string().min(1),
	refreshTokenSecretName: z.string().min(1).nullable(),
	connectedAt: z.string().min(1).nullable(),
	tokenRefreshedAt: z.string().min(1).nullable(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type UserIntegrationConnection = z.infer<
	typeof userIntegrationConnectionSchema
>

export type UserOauthAppWithConnectionCount = UserOauthApp & {
	connectionCount: number
}

/**
 * A connection joined to the app that owns its client credentials. The lane
 * discriminant matches which of `connection.appSlug` /
 * `connection.platformAppSlug` is set.
 */
export type JoinedIntegration =
	| {
			lane: 'user'
			app: UserOauthApp
			connection: UserIntegrationConnection
	  }
	| {
			lane: 'platform'
			app: PlatformOauthApp
			connection: UserIntegrationConnection
	  }

export type UserOauthAppRow = {
	user_id: string
	slug: string
	provider: string
	label: string | null
	client_id: string
	client_secret_secret_name: string | null
	token_url: string
	authorize_url: string | null
	api_base_url: string | null
	flow: (typeof integrationFlowValues)[number]
	use_pkce: number | null
	token_exchange_style: (typeof tokenExchangeStyleValues)[number] | null
	scope_separator: string | null
	extra_authorize_params_json: string
	created_at: string
	updated_at: string
}

export type UserIntegrationRow = {
	user_id: string
	name: string
	app_slug: string | null
	platform_app_slug: string | null
	account_label: string | null
	description: string
	scopes_json: string
	required_hosts_json: string
	access_token_secret_name: string
	refresh_token_secret_name: string | null
	connected_at: string | null
	token_refreshed_at: string | null
	created_at: string
	updated_at: string
}

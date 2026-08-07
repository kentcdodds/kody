import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	integrationFlowValues,
	tokenExchangeStyleValues,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	platformOauthAppPublicSchema,
	toPlatformOauthAppPublic,
} from '#mcp/capabilities/integrations/platform-app-shared.ts'
import { upsertPlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		slug: z
			.string()
			.min(1)
			.describe('Stable slug users connect with (for example "github").'),
		provider: z.string().min(1).optional().describe('Provider family key.'),
		label: z.string().min(1).nullable().optional(),
		clientId: z.string().min(1).describe('Provider OAuth client id.'),
		clientSecret: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Plaintext client secret; stored encrypted and never returned by any capability. Omit to keep the stored value, pass null to clear it (public PKCE apps).',
			),
		tokenUrl: z.string().url(),
		authorizeUrl: z.string().url(),
		apiBaseUrl: z.string().url().nullable().optional(),
		flow: z.enum(integrationFlowValues),
		usePkce: z.boolean().nullable().optional(),
		tokenExchangeStyle: z.enum(tokenExchangeStyleValues).nullable().optional(),
		scopeSeparator: z.string().min(1).nullable().optional(),
		extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
		allowedScopes: z
			.array(z.string())
			.optional()
			.describe('Scope superset connections may request (the verified menu).'),
		defaultScopes: z
			.array(z.string())
			.optional()
			.describe('Minimal scopes the connect flow requests by default.'),
		requiredHosts: z.array(z.string()).optional(),
		enabled: z
			.boolean()
			.optional()
			.describe('Disabled apps are hidden from users and reject new connects.'),
	})
	.strict()

const outputSchema = z.object({
	app: platformOauthAppPublicSchema,
})

export const adminPlatformOauthAppSaveCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_platform_oauth_app_save',
		description:
			'Create or update a platform (built-in) OAuth app that every user can connect through /connect/oauth without registering their own provider app. The client secret is encrypted at rest outside the user secret store and is never returned. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'oauth',
			'app',
			'built-in',
			'integration',
			'provision',
			'client secret',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_platform_oauth_app_save',
				async () => {
					const app = await upsertPlatformOauthApp({
						db: ctx.env.APP_DB,
						env: ctx.env,
						app: {
							slug: args.slug,
							provider: args.provider ?? null,
							label: args.label ?? null,
							clientId: args.clientId,
							clientSecret: args.clientSecret,
							tokenUrl: args.tokenUrl,
							authorizeUrl: args.authorizeUrl,
							apiBaseUrl: args.apiBaseUrl ?? null,
							flow: args.flow,
							usePkce: args.usePkce ?? null,
							tokenExchangeStyle: args.tokenExchangeStyle ?? null,
							scopeSeparator: args.scopeSeparator ?? null,
							extraAuthorizeParams: args.extraAuthorizeParams ?? {},
							allowedScopes: args.allowedScopes ?? [],
							defaultScopes: args.defaultScopes ?? [],
							requiredHosts: args.requiredHosts ?? [],
							...(args.enabled === undefined ? {} : { enabled: args.enabled }),
						},
					})
					return { app: toPlatformOauthAppPublic(app) }
				},
				{
					successReason: ({ app }) => `platform_oauth_app=${app.slug}`,
				},
			)
		},
	},
)

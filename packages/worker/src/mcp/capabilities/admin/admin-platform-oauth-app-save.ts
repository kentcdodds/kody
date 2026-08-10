import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	canonicalIntegrationName,
	integrationFlowValues,
	tokenExchangeStyleValues,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	platformOauthAppPublicSchema,
	toPlatformOauthAppPublic,
} from '#mcp/capabilities/integrations/platform-app-shared.ts'
import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { setPlatformOauthAppLogo } from '#worker/integrations/platform-app-logo.ts'
import {
	PlatformOauthAppValidationError,
	renamePlatformOauthApp,
	upsertPlatformOauthApp,
} from '#worker/integrations/platform-apps.ts'
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
		newSlug: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Renames the app in place before applying the rest of the save: the encrypted client secret, logo, and existing user connections all carry over to the new slug (connection names are untouched). Users then connect at /connect/oauth?provider=<newSlug>.',
			),
		provider: z.string().min(1).optional().describe('Provider family key.'),
		label: z.string().min(1).nullable().optional(),
		description: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Operator-authored note shown to users and agents before they connect — provider-specific limitations, scope caveats, and the like. Omit to keep the stored value, pass null to clear.',
			),
		clientId: z.string().min(1).describe('Provider OAuth client id.'),
		clientSecret: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Plaintext client secret; stored encrypted and never returned by any capability. Omit to keep the stored value, pass null to clear it (public PKCE apps). Confidential apps may stage without a secret while enabled is false — the operator pastes credentials in /admin/platform-integrations before enabling.',
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
			.describe(
				'Disabled apps are hidden from users and reject new connects. Defaults to enabled on create; pass false to stage a confidential app before its client secret exists.',
			),
		logoBase64: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Base64-encoded provider logo (SVG, PNG, JPEG, or WebP; SVG is rasterized to PNG before storage). Omit to keep the current logo, pass null to remove it.',
			),
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
					// A changed slug renames in place first (carrying the
					// write-only secret, logo, and user connections), then the
					// upsert applies the rest of the edit to it. Case-only
					// changes canonicalize equal and are not renames.
					const renameTo =
						args.newSlug &&
						canonicalIntegrationName(args.newSlug) !==
							canonicalIntegrationName(args.slug)
							? args.newSlug
							: null
					let renamedSlug: string | null = null
					try {
						if (renameTo) {
							const renamed = await renamePlatformOauthApp({
								db: ctx.env.APP_DB,
								slug: args.slug,
								newSlug: renameTo,
							})
							renamedSlug = renamed.slug
						}
						const targetSlug = renamedSlug ?? args.slug
						// Omitted optional fields stay `undefined` so the upsert's
						// retain-on-omit semantics apply: a partial save never
						// silently clears the scope menu, hosts, or stored secret.
						let app = await upsertPlatformOauthApp({
							db: ctx.env.APP_DB,
							env: ctx.env,
							app: {
								slug: targetSlug,
								provider: args.provider,
								label: args.label,
								description: args.description,
								clientId: args.clientId,
								clientSecret: args.clientSecret,
								tokenUrl: args.tokenUrl,
								authorizeUrl: args.authorizeUrl,
								apiBaseUrl: args.apiBaseUrl,
								flow: args.flow,
								usePkce: args.usePkce,
								tokenExchangeStyle: args.tokenExchangeStyle,
								scopeSeparator: args.scopeSeparator,
								extraAuthorizeParams: args.extraAuthorizeParams,
								allowedScopes: args.allowedScopes,
								defaultScopes: args.defaultScopes,
								requiredHosts: args.requiredHosts,
								enabled: args.enabled,
							},
						})
						if (args.logoBase64 !== undefined) {
							app = await setPlatformOauthAppLogo({
								db: ctx.env.APP_DB,
								env: ctx.env,
								slug: app.slug,
								sourceBytes:
									args.logoBase64 === null
										? null
										: base64ToBytes(args.logoBase64),
							})
						}
						return { app: toPlatformOauthAppPublic(app) }
					} catch (error) {
						// The rename committed before the failing step; undo it
						// (best effort) so a rejected edit never leaves the row
						// under a half-applied slug.
						if (renamedSlug) {
							await renamePlatformOauthApp({
								db: ctx.env.APP_DB,
								slug: renamedSlug,
								newSlug: args.slug,
							}).catch(() => {})
						}
						// Staging/enable mistakes (secretless confidential while
						// enabled, empty required fields) are caller-clearable —
						// keep them off Sentry via McpCallerError.
						if (error instanceof PlatformOauthAppValidationError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: ({ app }) => `platform_oauth_app=${app.slug}`,
				},
			)
		},
	},
)

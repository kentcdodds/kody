import { z } from 'zod'
import {
	apiTokenScopeDescriptions,
	apiTokenScopeSatisfies,
	apiTokenScopes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'
import {
	apiTokenIdleTtlDescription,
	apiTokenLifetimeAliasNames,
	apiTokenPolicy,
	getApiTokenRecord,
	listApiTokens,
	mintApiToken,
	resolveApiTokenLifetime,
	revokeApiToken,
	rotateApiToken,
	toApiTokenView,
} from '#worker/api-tokens/service.ts'
import { redeemCliCredentialBootstrap } from '#worker/api-tokens/cli-credential-bootstrap.ts'
import { type ApiInvocationContext } from './context.ts'
import { ApiError, invalidRequest, notFound } from './errors.ts'
import {
	parseNativeInput,
	requireTokenPrincipal,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'
import { connectionProfilesFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { readCallerConnectionProfileName } from '#worker/connection-profiles/access.ts'
import { getConnectionProfileByName } from '#worker/connection-profiles/repo.ts'
import {
	connectionProfileNameErrorMessage,
	getConnectionProfileNameValidationError,
	normalizeConnectionProfileName,
} from '#universal/connection-profiles/names.ts'

const scopeSchema = z.enum(
	apiTokenScopes as [ApiTokenScope, ...Array<ApiTokenScope>],
)

const scopeListDescription = Object.entries(apiTokenScopeDescriptions)
	.map(([scope, description]) => `\`${scope}\`: ${description}`)
	.join('\n')

const tokenIdSchema = z
	.string()
	.min(1)
	.describe('API token id (the part after `kody_at_` and before `_`).')

const tokenViewSchema = z.object({
	id: z.string(),
	name: z.string(),
	scopes: z.array(scopeSchema),
	status: z.enum(['active', 'expired', 'revoked']),
	idle_ttl_seconds: z.number().int(),
	expires_at: z
		.string()
		.describe('Sliding expiry. Each successful request pushes it forward.'),
	max_expires_at: z
		.string()
		.describe('Absolute expiry. The token never outlives it.'),
	created_via: z.string(),
	created_at: z.string(),
	last_used_at: z.string().nullable(),
	rotated_at: z.string().nullable(),
	revoked_at: z.string().nullable(),
	profile_name: z
		.string()
		.nullable()
		.describe(
			'Named connection profile this token is bound to, or null for unlimited.',
		),
})

const tokenSecretViewSchema = tokenViewSchema.extend({
	token: z
		.string()
		.describe(
			'The bearer token. Shown once; Kody stores only a hash. Send it as `Authorization: Bearer <token>`.',
		),
	token_type: z.literal('Bearer'),
})

export const emptyInputSchema = z.object({}).strict()

const lifetimeAliasSchema = z.enum(
	apiTokenLifetimeAliasNames as [string, ...Array<string>],
)

const tokenCreateInputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(apiTokenPolicy.maxNameLength)
			.describe('Label shown in token lists, e.g. `kody-cli on laptop`.'),
		scopes: z
			.array(scopeSchema)
			.min(1)
			.describe(
				`Scopes to grant. \`<resource>:write\` also grants \`<resource>:read\`. A token can only mint tokens with scopes it holds.\n${scopeListDescription}`,
			),
		profile: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe(
				'Optional connection profile name. The token’s package access is limited to that profile’s grants. Experimenters only.',
			),
		lifetime: lifetimeAliasSchema
			.optional()
			.describe(
				'Required unless idle_ttl_seconds and max_lifetime_seconds are both set. `short` = 1h idle / 24h max. `long` = 14d idle / 3mo max. Single-task agents should use `short`.',
			),
		idle_ttl_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxIdleTtlSeconds)
			.optional()
			.describe(
				'Seconds without use before the token expires. Required with max_lifetime_seconds when lifetime is omitted.',
			),
		max_lifetime_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxMaxLifetimeSeconds)
			.optional()
			.describe(
				'Absolute lifetime cap in seconds. Required with idle_ttl_seconds when lifetime is omitted.',
			),
	})
	.strict()

const tokenListInputSchema = z
	.object({
		include_inactive: z
			.boolean()
			.optional()
			.describe('Include expired and revoked tokens (kept for 7 days).'),
	})
	.strict()

const tokenIdInputSchema = z.object({ token_id: tokenIdSchema }).strict()

const tokenRevokeOutputSchema = z.object({
	id: z.string(),
	revoked: z.literal(true),
})

function userIdOf(ctx: ApiInvocationContext) {
	return ctx.callerContext.user.userId
}

/**
 * Rotating returns a fresh secret for the target, so a token may only rotate
 * another token it could have minted: every target scope held, and no later
 * absolute expiry.
 */
async function assertCallerMayRotate(
	ctx: ApiInvocationContext,
	tokenId: string,
) {
	if (ctx.principal.kind !== 'token') return
	const caller = ctx.principal.token
	if (caller.id === tokenId) return
	const target = await getApiTokenRecord({
		db: ctx.env.APP_DB,
		userId: userIdOf(ctx),
		tokenId,
	})
	if (!target) return
	const missing = target.scopes.filter(
		(scope) => !apiTokenScopeSatisfies(caller.scopes, scope),
	)
	const outlives =
		Date.parse(target.max_expires_at) > Date.parse(caller.max_expires_at)
	const callerProfile = caller.profile_name ?? null
	const targetProfile = target.profile_name ?? null
	const profileEscalation =
		callerProfile != null && callerProfile !== targetProfile
	if (missing.length === 0 && !outlives && !profileEscalation) return
	throw new ApiError({
		status: 403,
		code: 'insufficient_scope',
		message: profileEscalation
			? 'This profile-bound API token cannot rotate a token for a different connection profile (or an unlimited token).'
			: missing.length > 0
				? `This API token cannot rotate a token with scopes it does not hold: ${missing.join(', ')}.`
				: 'This API token cannot rotate a token that outlives it.',
		details: { missing_scopes: missing },
	})
}

async function rotateOrThrow(ctx: ApiInvocationContext, tokenId: string) {
	await assertCallerMayRotate(ctx, tokenId)
	const rotated = await rotateApiToken({
		db: ctx.env.APP_DB,
		userId: userIdOf(ctx),
		tokenId,
	})
	if (!rotated) throw notFound(`Active API token "${tokenId}" not found.`)
	return rotated
}

async function revokeOrThrow(ctx: ApiInvocationContext, tokenId: string) {
	const revoked = await revokeApiToken({
		db: ctx.env.APP_DB,
		userId: userIdOf(ctx),
		tokenId,
	})
	if (!revoked) throw notFound(`Active API token "${tokenId}" not found.`)
	return { id: tokenId, revoked: true as const }
}

const ttlDescription = apiTokenIdleTtlDescription()

export const tokenOperationDefinitions: Record<
	Extract<NativeApiOperationId, `token${string}`>,
	NativeApiOperationDefinition
> = {
	tokenList: {
		summary: 'List API tokens',
		description: `List this account's API tokens (metadata only; token values are never returned after mint). ${ttlDescription}`,
		inputSchema: tokenListInputSchema,
		outputSchema: z.object({ tokens: z.array(tokenViewSchema) }),
		readOnly: true,
		async handler(params, ctx) {
			const input = parseNativeInput(tokenListInputSchema, params)
			return {
				tokens: await listApiTokens({
					db: ctx.env.APP_DB,
					userId: userIdOf(ctx),
					includeInactive: input.include_inactive ?? false,
				}),
			}
		},
	},
	tokenCreate: {
		summary: 'Mint a scoped API token',
		description: `Mint a scoped API token for this account. The token value is returned once. ${ttlDescription} A token-authenticated caller can only grant scopes it holds and cannot outlive its own max_expires_at.`,
		inputSchema: tokenCreateInputSchema,
		outputSchema: tokenSecretViewSchema,
		readOnly: false,
		async handler(params, ctx) {
			const input = parseNativeInput(tokenCreateInputSchema, params)
			const lifetime = resolveApiTokenLifetime({
				lifetime: input.lifetime,
				idleTtlSeconds: input.idle_ttl_seconds,
				maxLifetimeSeconds: input.max_lifetime_seconds,
			})
			const parent =
				ctx.principal.kind === 'token'
					? {
							scopes: ctx.principal.token.scopes,
							maxExpiresAt: ctx.principal.token.max_expires_at,
							profileName: ctx.principal.token.profile_name ?? null,
						}
					: undefined
			const callerProfileName = readCallerConnectionProfileName(
				ctx.callerContext,
			)
			let profileName: string | null = null
			if (input.profile !== undefined) {
				profileName = normalizeConnectionProfileName(input.profile)
				const nameError = getConnectionProfileNameValidationError(profileName)
				if (nameError) {
					throw invalidRequest(connectionProfileNameErrorMessage(nameError))
				}
				const userRow = await ctx.env.APP_DB.prepare(
					`SELECT id FROM users WHERE stable_user_id = ?`,
				)
					.bind(userIdOf(ctx))
					.first<{ id: number }>()
				const enabled =
					userRow != null &&
					(await isFeatureEnabled(
						ctx.env.APP_DB,
						connectionProfilesFlagKey,
						userRow.id,
					))
				if (!enabled) {
					throw new ApiError({
						status: 404,
						code: 'not_found',
						message: 'Connection profiles are not enabled for this account.',
					})
				}
				const profile = await getConnectionProfileByName({
					db: ctx.env.APP_DB,
					userId: userIdOf(ctx),
					name: profileName,
				})
				if (!profile) {
					throw notFound(`Connection profile "${profileName}" not found.`)
				}
				profileName = profile.name
			} else if (parent?.profileName) {
				profileName = parent.profileName
			} else if (callerProfileName) {
				// MCP OAuth / session callers inherit their stamped profile so they
				// cannot mint an unlimited token by omitting `profile`.
				profileName = callerProfileName
			}
			if (
				callerProfileName &&
				profileName &&
				callerProfileName !== profileName
			) {
				throw new ApiError({
					status: 403,
					code: 'insufficient_scope',
					message: `This connection profile can only mint tokens for profile "${callerProfileName}".`,
				})
			}
			if (callerProfileName && !profileName) {
				throw new ApiError({
					status: 403,
					code: 'insufficient_scope',
					message:
						'This connection profile cannot mint an unlimited API token.',
				})
			}
			return mintApiToken({
				db: ctx.env.APP_DB,
				userId: userIdOf(ctx),
				name: input.name,
				scopes: input.scopes,
				idleTtlSeconds: lifetime.idleTtlSeconds,
				maxLifetimeSeconds: lifetime.maxLifetimeSeconds,
				createdVia: ctx.principal.kind === 'token' ? 'api' : 'mcp-api',
				...(parent ? { parent } : {}),
				...(ctx.principal.kind === 'token'
					? { excludeTokenId: ctx.principal.token.id }
					: {}),
				profileName,
			})
		},
	},
	tokenGetCurrent: {
		summary: 'Describe the calling token',
		description:
			'Return the calling API token: scopes, sliding expiry, and absolute expiry. Needs no scope. Use it to check how long a token has left.',
		inputSchema: emptyInputSchema,
		outputSchema: tokenViewSchema,
		readOnly: true,
		async handler(params, ctx) {
			parseNativeInput(emptyInputSchema, params)
			return toApiTokenView(requireTokenPrincipal(ctx))
		},
	},
	tokenRotateCurrent: {
		summary: 'Rotate the calling token',
		description:
			'Replace the calling token with a new value. The old value stops working immediately; scopes and max_expires_at are unchanged. Needs no scope.',
		inputSchema: emptyInputSchema,
		outputSchema: tokenSecretViewSchema,
		readOnly: false,
		async handler(params, ctx) {
			parseNativeInput(emptyInputSchema, params)
			return rotateOrThrow(ctx, requireTokenPrincipal(ctx).id)
		},
	},
	tokenRevokeCurrent: {
		summary: 'Revoke the calling token',
		description:
			'Revoke the calling token immediately (for example when a local session ends). Needs no scope.',
		inputSchema: emptyInputSchema,
		outputSchema: tokenRevokeOutputSchema,
		readOnly: false,
		async handler(params, ctx) {
			parseNativeInput(emptyInputSchema, params)
			return revokeOrThrow(ctx, requireTokenPrincipal(ctx).id)
		},
	},
	tokenGet: {
		summary: 'Get an API token',
		description: 'Return one API token by id (metadata only).',
		inputSchema: tokenIdInputSchema,
		outputSchema: tokenViewSchema,
		readOnly: true,
		async handler(params, ctx) {
			const input = parseNativeInput(tokenIdInputSchema, params)
			const record = await getApiTokenRecord({
				db: ctx.env.APP_DB,
				userId: userIdOf(ctx),
				tokenId: input.token_id,
			})
			if (!record) throw notFound(`API token "${input.token_id}" not found.`)
			return toApiTokenView(record)
		},
	},
	tokenRotate: {
		summary: 'Rotate an API token',
		description:
			'Replace an active token with a new value. The old value stops working immediately; scopes and max_expires_at are unchanged. A token-authenticated caller can only rotate tokens whose scopes it holds and that do not outlive it.',
		inputSchema: tokenIdInputSchema,
		outputSchema: tokenSecretViewSchema,
		readOnly: false,
		async handler(params, ctx) {
			const input = parseNativeInput(tokenIdInputSchema, params)
			return rotateOrThrow(ctx, input.token_id)
		},
	},
	tokenRevoke: {
		summary: 'Revoke an API token',
		description: 'Revoke an API token immediately.',
		inputSchema: tokenIdInputSchema,
		outputSchema: tokenRevokeOutputSchema,
		readOnly: false,
		async handler(params, ctx) {
			const input = parseNativeInput(tokenIdInputSchema, params)
			return revokeOrThrow(ctx, input.token_id)
		},
	},
}

export const bootstrapRedeemInputSchema = z
	.object({
		code: z
			.string()
			.min(1)
			.describe(
				'One-shot `kody_bc_…` bootstrap code from `cliCredentialBootstrap`.',
			),
		lifetime: lifetimeAliasSchema
			.optional()
			.describe(
				'Required unless idle_ttl_seconds and max_lifetime_seconds are both set. `short` = 1h idle / 24h max. `long` = 14d idle / 3mo max. Single-task agents should use `short`.',
			),
		idle_ttl_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxIdleTtlSeconds)
			.optional()
			.describe(
				'Seconds without use before the redeemed token expires. Required with max_lifetime_seconds when lifetime is omitted.',
			),
		max_lifetime_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxMaxLifetimeSeconds)
			.optional()
			.describe(
				'Absolute lifetime cap for the redeemed token in seconds. Required with idle_ttl_seconds when lifetime is omitted.',
			),
	})
	.strict()

/**
 * CLI-only redeem. Rejected for MCP `api` (returns the secret into chat).
 * HTTP calls skip Bearer auth and authenticate solely by the one-shot code.
 */
export const cliCredentialBootstrapRedeemDefinition: NativeApiOperationDefinition =
	{
		summary: 'Redeem a CLI credential bootstrap code',
		description: `Exchange a one-shot \`kody_bc_…\` bootstrap code for a scoped \`kody_at_…\` API token. For \`@kodycodes/cli auth bootstrap\` only — not the MCP \`api\` tool. No Authorization header; the code is the credential. The code burns on first successful redeem. Lifetime is required on redeem (CLI flags). ${ttlDescription}`,
		inputSchema: bootstrapRedeemInputSchema,
		outputSchema: tokenSecretViewSchema,
		readOnly: false,
		async handler(params, ctx) {
			if (ctx.principal.kind === 'mcp') {
				throw invalidRequest(
					'cliCredentialBootstrapRedeem is HTTP/CLI only. Call cliCredentialBootstrap for a one-shot code, then run `npx @kodycodes/cli auth bootstrap --code … --lifetime short` — do not redeem through MCP `api` (that would return a kody_at_ into chat).',
				)
			}
			const input = parseNativeInput(bootstrapRedeemInputSchema, params)
			const redeemed = await redeemCliCredentialBootstrap({
				db: ctx.env.APP_DB,
				code: input.code,
				env: ctx.env,
				lifetime: input.lifetime,
				idleTtlSeconds: input.idle_ttl_seconds,
				maxLifetimeSeconds: input.max_lifetime_seconds,
			})
			return redeemed.token
		},
	}

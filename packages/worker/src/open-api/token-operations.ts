import { z } from 'zod'
import { localExecuteFlagKey } from '#universal/feature-flags/registry.ts'
import {
	apiTokenScopeDescriptions,
	apiTokenScopeSatisfies,
	apiTokenScopes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'
import {
	apiTokenIdleTtlDescription,
	apiTokenPolicy,
	getApiTokenRecord,
	listApiTokens,
	mintApiToken,
	revokeApiToken,
	rotateApiToken,
	toApiTokenView,
} from '#worker/api-tokens/service.ts'
import { type ApiInvocationContext } from './context.ts'
import { ApiError, notFound } from './errors.ts'
import {
	parseNativeInput,
	requireTokenPrincipal,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'

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
		idle_ttl_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxIdleTtlSeconds)
			.optional()
			.describe(
				`Seconds without use before the token expires (default ${apiTokenPolicy.defaultIdleTtlSeconds}).`,
			),
		max_lifetime_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxMaxLifetimeSeconds)
			.optional()
			.describe(
				`Absolute lifetime cap in seconds (default ${apiTokenPolicy.defaultMaxLifetimeSeconds}).`,
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
	if (missing.length === 0 && !outlives) return
	throw new ApiError({
		status: 403,
		code: 'insufficient_scope',
		message:
			missing.length > 0
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
		description: `Mint a short-lived, scoped API token for this account. The token value is returned once. ${ttlDescription} The \`local-execute\` scope requires the local-execute feature flag. A token-authenticated caller can only grant scopes it holds and cannot outlive its own max_expires_at.`,
		inputSchema: tokenCreateInputSchema,
		outputSchema: tokenSecretViewSchema,
		readOnly: false,
		async handler(params, ctx) {
			const input = parseNativeInput(tokenCreateInputSchema, params)
			const featureFlags = input.scopes.includes('local-execute')
				? await ctx.getFeatureFlags()
				: null
			const parent =
				ctx.principal.kind === 'token'
					? {
							scopes: ctx.principal.token.scopes,
							maxExpiresAt: ctx.principal.token.max_expires_at,
						}
					: undefined
			return mintApiToken({
				db: ctx.env.APP_DB,
				userId: userIdOf(ctx),
				name: input.name,
				scopes: input.scopes,
				...(input.idle_ttl_seconds === undefined
					? {}
					: { idleTtlSeconds: input.idle_ttl_seconds }),
				...(input.max_lifetime_seconds === undefined
					? {}
					: { maxLifetimeSeconds: input.max_lifetime_seconds }),
				createdVia: ctx.principal.kind === 'token' ? 'api' : 'mcp-api',
				allowLocalExecute: featureFlags?.[localExecuteFlagKey] === true,
				...(parent ? { parent } : {}),
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

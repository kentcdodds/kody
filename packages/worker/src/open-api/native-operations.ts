import { localExecuteScope } from '#worker/api-tokens/scopes.ts'
import { toApiTokenView } from '#worker/api-tokens/service.ts'
import {
	capabilityProxyCallInputSchema,
	capabilityProxyCallOutputSchema,
	capabilityProxyLimits,
	capabilityProxySessionOutputSchema,
	capabilityProxyUsageEntityId,
	runCapabilityProxyCall,
} from './capability-proxy.ts'
import { localExecutePackageGraphOperationDefinitions } from './local-execute-package-graph.ts'
import {
	parseNativeInput,
	requireLocalExecuteHttpPrincipal,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'
import {
	emptyInputSchema,
	cliCredentialBootstrapRedeemDefinition,
	tokenOperationDefinitions,
} from './token-operations.ts'

function capabilityProxySessionFromPrincipal(
	ctx: Parameters<NativeApiOperationDefinition['handler']>[1],
) {
	const principal = requireLocalExecuteHttpPrincipal(ctx)
	const user = {
		userId: ctx.callerContext.user.userId,
		email: ctx.callerContext.user.email,
	}
	const limits = {
		maxPathSegments: capabilityProxyLimits.maxPathSegments,
		maxArgs: capabilityProxyLimits.maxArgs,
		maxRequestBytes: capabilityProxyLimits.maxRequestBytes,
	}
	switch (principal.kind) {
		case 'token': {
			const token = toApiTokenView(principal.token)
			return {
				scopes: token.scopes,
				expiresAt: token.expires_at,
				maxExpiresAt: token.max_expires_at,
				idleTtlSeconds: token.idle_ttl_seconds,
				user,
				limits,
			}
		}
		case 'mcp-oauth': {
			// Effective grant for these surfaces matches a `local-execute` API
			// token (full kody.* via CapabilityProxy). OIDC grant scopes are
			// identity claims, not capability scopes (ADR 0049/0055).
			const expiresAt = new Date(principal.expiresAtUnix * 1000).toISOString()
			const remainingSeconds = Math.max(
				0,
				principal.expiresAtUnix - Math.floor(Date.now() / 1000),
			)
			return {
				scopes: [localExecuteScope],
				expiresAt,
				maxExpiresAt: expiresAt,
				idleTtlSeconds: remainingSeconds,
				user,
				limits,
			}
		}
		default: {
			const exhaustive: never = principal
			throw new Error(
				`Unexpected local-execute principal: ${String(exhaustive)}`,
			)
		}
	}
}

const capabilityProxyOperationDefinitions: Record<
	Extract<NativeApiOperationId, `capabilityProxy${string}`>,
	NativeApiOperationDefinition
> = {
	capabilityProxySession: {
		summary: 'Open a CapabilityProxy session',
		description:
			'Preflight for local execute: confirms the bearer is valid (scoped `kody_at_` with `local-execute`, or CLI `kody login` MCP OAuth). Returns scopes, expiry, and proxy limits. Call before starting user code.',
		inputSchema: emptyInputSchema,
		outputSchema: capabilityProxySessionOutputSchema,
		readOnly: true,
		async handler(params, ctx) {
			parseNativeInput(emptyInputSchema, params)
			return capabilityProxySessionFromPrincipal(ctx)
		},
	},
	capabilityProxyCall: {
		summary: 'Proxy one kody:runtime call',
		description:
			"Run one `kody:runtime` call from a local execute venue: `path` is the runtime property path (`['kody','emailSend']`, `['kody','authenticatedFetch']`, `['kody','oauthClientCredentials']`, `['kody','mcp',server,tool]`, `['kody','packageStorageGet']`, `['workflows','create']`) and `args` the positional arguments. Behaves like the same call inside cloud execute. Authenticated fetch, OAuth client-credentials grants, and stamped packageStorage / packageSecrets hop here so OAuth tokens and secret plaintext stay on origin. Accepts a scoped API token or CLI MCP OAuth. There is no author-facing `packages.invoke`. Errors use the standard envelope; capability failures return `capability_error` with the capability's message.",
		inputSchema: capabilityProxyCallInputSchema,
		outputSchema: capabilityProxyCallOutputSchema,
		readOnly: false,
		usageEntityId: capabilityProxyUsageEntityId,
		async handler(params, ctx) {
			requireLocalExecuteHttpPrincipal(ctx)
			return runCapabilityProxyCall({
				ctx,
				call: parseNativeInput(capabilityProxyCallInputSchema, params),
			})
		},
	},
}

export const nativeApiOperationDefinitions: Record<
	NativeApiOperationId,
	NativeApiOperationDefinition
> = {
	...tokenOperationDefinitions,
	cliCredentialBootstrapRedeem: cliCredentialBootstrapRedeemDefinition,
	...capabilityProxyOperationDefinitions,
	...localExecutePackageGraphOperationDefinitions,
}

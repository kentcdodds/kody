import { toApiTokenView } from '#worker/api-tokens/service.ts'
import {
	capabilityProxyCallInputSchema,
	capabilityProxyCallOutputSchema,
	capabilityProxyFeatures,
	capabilityProxyLimits,
	capabilityProxySessionOutputSchema,
	capabilityProxyUsageEntityId,
	runCapabilityProxyCall,
} from './capability-proxy.ts'
import { invalidRequest } from './errors.ts'
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
	const features = [...capabilityProxyFeatures]
	switch (principal.kind) {
		case 'token': {
			const token = toApiTokenView(principal.token)
			return {
				scopes: token.scopes,
				expiresAt: token.expires_at,
				maxExpiresAt: token.max_expires_at,
				idleTtlSeconds: token.idle_ttl_seconds,
				user,
				features,
				limits,
			}
		}
		case 'mcp-oauth': {
			// Effective grant for these surfaces matches an `org:execute` API
			// token (full kody.* via CapabilityProxy). OIDC grant scopes are
			// identity claims, not capability scopes (ADR 0049/0055).
			const expiresAt = new Date(principal.expiresAtUnix * 1000).toISOString()
			const remainingSeconds = Math.max(
				0,
				principal.expiresAtUnix - Math.floor(Date.now() / 1000),
			)
			return {
				scopes: ['org:execute'],
				expiresAt,
				maxExpiresAt: expiresAt,
				idleTtlSeconds: remainingSeconds,
				user,
				features,
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
			'Preflight for local execute: confirms the bearer is valid (scoped `kody_at_` with `org:execute`, or CLI `kody login` MCP OAuth). Returns scopes, expiry, and proxy limits. Call before starting user code.',
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
			"Run one `kody:runtime` call from a local execute venue: `path` is the runtime property path (`['kody','emailSend']`, `['kody','authenticatedFetch']`, `['kody','oauthClientCredentials']`, `['kody','mcp',server,tool]`, `['kody','packageStorageGet']`, `['workflows','create']`) and `args` the positional arguments. Behaves like the same call inside cloud execute. Authenticated fetch, OAuth client-credentials grants, and stamped packageStorage / packageSecrets hop here so OAuth tokens and secret plaintext stay on origin. Accepts a scoped API token or CLI MCP OAuth. Errors use the standard envelope; capability failures return `capability_error` with the capability's message.",
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
	capabilityProxyGatewayFetch: {
		summary: 'Stream a secret-bearing outbound fetch',
		description:
			'Native streaming hop for local execute: the request body is the outbound fetch body (raw bytes, no JSON wrapper). Hop metadata is in `X-Kody-Gateway-Url` (required), `X-Kody-Gateway-Method`, `X-Kody-Gateway-Package-Id`, `X-Kody-Gateway-Headers`, and `x-kody-secret-resolution`. A successful response is the upstream HTTP response, streamed — not `{ status, headers, bodyBase64 }`. Requires `org:execute` and a scoped API token or CLI MCP OAuth bearer. Not available as a JSON MCP `api` invoke; use `POST /v1/capability-proxy/gateway-fetch`.',
		inputSchema: emptyInputSchema,
		outputSchema: emptyInputSchema,
		readOnly: false,
		async handler() {
			throw invalidRequest(
				'capabilityProxyGatewayFetch is a streaming HTTP route only. POST /v1/capability-proxy/gateway-fetch with X-Kody-Gateway-* headers; do not invoke it as JSON.',
			)
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

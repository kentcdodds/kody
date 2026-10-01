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
	requireTokenPrincipal,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'
import { type NativeApiOperationId } from './operations.ts'
import {
	emptyInputSchema,
	tokenOperationDefinitions,
} from './token-operations.ts'

const capabilityProxyOperationDefinitions: Record<
	Extract<NativeApiOperationId, `capabilityProxy${string}`>,
	NativeApiOperationDefinition
> = {
	capabilityProxySession: {
		summary: 'Open a CapabilityProxy session',
		description:
			'Preflight for local execute: confirms the token is valid, holds the `local-execute` scope, and the account has the `local-execute` feature flag. Returns the token scopes, expiry, and proxy limits. Call before starting user code.',
		inputSchema: emptyInputSchema,
		outputSchema: capabilityProxySessionOutputSchema,
		readOnly: true,
		async handler(params, ctx) {
			parseNativeInput(emptyInputSchema, params)
			const token = toApiTokenView(requireTokenPrincipal(ctx))
			return {
				scopes: token.scopes,
				expiresAt: token.expires_at,
				maxExpiresAt: token.max_expires_at,
				idleTtlSeconds: token.idle_ttl_seconds,
				user: {
					userId: ctx.callerContext.user.userId,
					email: ctx.callerContext.user.email,
				},
				limits: {
					maxPathSegments: capabilityProxyLimits.maxPathSegments,
					maxArgs: capabilityProxyLimits.maxArgs,
					maxRequestBytes: capabilityProxyLimits.maxRequestBytes,
				},
			}
		},
	},
	capabilityProxyCall: {
		summary: 'Proxy one kody:runtime call',
		description:
			"Run one `kody:runtime` call from a local execute venue: `path` is the runtime property path (`['kody','emailSend']`, `['kody','authenticatedFetch']`, `['kody','mcp',server,tool]`, `['kody','packageStorageGet']`, `['workflows','create']`) and `args` the positional arguments. Behaves like the same call inside cloud execute. Authenticated fetch and stamped packageStorage / packageSecrets hop here so OAuth tokens stay on origin. There is no author-facing `packages.invoke`. Errors use the standard envelope; capability failures return `capability_error` with the capability's message.",
		inputSchema: capabilityProxyCallInputSchema,
		outputSchema: capabilityProxyCallOutputSchema,
		readOnly: false,
		usageEntityId: capabilityProxyUsageEntityId,
		async handler(params, ctx) {
			requireTokenPrincipal(ctx)
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
	...capabilityProxyOperationDefinitions,
	...localExecutePackageGraphOperationDefinitions,
}

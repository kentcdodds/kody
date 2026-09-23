import {
	internalExecuteRuntimeInvokeTokenId,
	internalPackageRuntimeInvokeTokenId,
} from './common.ts'

/**
 * Sibling daily quota for always-on automation entrypoints (webhooks, HTTP
 * package-export invocations, subscriptions, package-backed workflows).
 * Distinct from MCP ad-hoc `execute_calls_per_day` and from scheduled
 * `job_runs_per_day`.
 */
export const automationInvocationsPerDayResource =
	'automation_invocations_per_day' as const

/** Host-only sealed secret-provider invoke (see sealed-invoke.ts). */
const internalSealedSecretProviderTokenId = 'internal:secret-provider-sealed'

/**
 * Whether this package-module run should burn
 * {@link automationInvocationsPerDayResource}.
 *
 * Counts top-level always-on entrypoints only. Nested invokes from MCP
 * execute or from another package runtime already paid at the parent
 * (execute or automation). Jobs use `job_runs_per_day` on their own path
 * and never enter this helper.
 *
 * Skip decisions use **actor token identity only**. Caller-supplied
 * `request.source` is not trusted — HTTP package-export clients choose
 * that field and must not be able to opt out of the quota.
 */
export function shouldConsumeAutomationInvocationEntitlement(input: {
	actorTokenId: string
	runtimeInvokeDepth: number
}): boolean {
	if (input.runtimeInvokeDepth > 0) return false
	if (input.actorTokenId === internalExecuteRuntimeInvokeTokenId) return false
	if (
		input.actorTokenId === internalPackageRuntimeInvokeTokenId ||
		input.actorTokenId.startsWith(`${internalPackageRuntimeInvokeTokenId}:`)
	) {
		return false
	}
	if (input.actorTokenId === internalSealedSecretProviderTokenId) return false
	return true
}

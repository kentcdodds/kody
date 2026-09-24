import { expect, test } from 'vitest'
import {
	internalExecuteRuntimeInvokeTokenId,
	internalPackageRuntimeInvokeTokenId,
} from './common.ts'
import { shouldConsumeAutomationInvocationEntitlement } from './automation-invocation-entitlement.ts'

test('shouldConsumeAutomationInvocationEntitlement covers top-level always-on entrypoints only', () => {
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'discord-gateway',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)

	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: internalExecuteRuntimeInvokeTokenId,
			runtimeInvokeDepth: 0,
		}),
	).toBe(false)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: `${internalPackageRuntimeInvokeTokenId}:pkg-1`,
			runtimeInvokeDepth: 0,
		}),
	).toBe(false)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'discord-gateway',
			runtimeInvokeDepth: 1,
		}),
	).toBe(false)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'internal:secret-provider-sealed',
			runtimeInvokeDepth: 0,
		}),
	).toBe(false)
})

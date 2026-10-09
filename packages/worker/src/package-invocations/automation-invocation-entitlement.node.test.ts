import { expect, test } from 'vitest'
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

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
			actorTokenId: 'internal:webhook:endpoint-1',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'internal:email-subscriptions',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'internal:package-events',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'workflow-step',
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

test('caller-supplied source strings cannot opt out of automation quota', () => {
	// HTTP package-export clients control `request.source`. Quota skips must
	// not key off that field — only the actor token identity.
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'discord-gateway',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
})

import { expect, test } from 'vitest'
import {
	internalExecuteRuntimeInvokeTokenId,
	internalPackageRuntimeInvokeTokenId,
} from './common.ts'
import { sealedSecretProviderInvocationSource } from '#worker/package-runtime/package-invocation-sources.ts'
import { shouldConsumeAutomationInvocationEntitlement } from './automation-invocation-entitlement.ts'

test('shouldConsumeAutomationInvocationEntitlement covers top-level always-on entrypoints only', () => {
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'discord-gateway',
			source: 'discord-gateway',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'internal:webhook:endpoint-1',
			source: 'webhook',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'internal:email-subscriptions',
			source: 'email',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'internal:package-events',
			source: 'package-event',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'workflow-step',
			source: 'package-workflow',
			runtimeInvokeDepth: 0,
		}),
	).toBe(true)

	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: internalExecuteRuntimeInvokeTokenId,
			source: 'execute',
			runtimeInvokeDepth: 0,
		}),
	).toBe(false)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: `${internalPackageRuntimeInvokeTokenId}:pkg-1`,
			source: 'package:@owner/leaf',
			runtimeInvokeDepth: 0,
		}),
	).toBe(false)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'discord-gateway',
			source: 'discord-gateway',
			runtimeInvokeDepth: 1,
		}),
	).toBe(false)
	expect(
		shouldConsumeAutomationInvocationEntitlement({
			actorTokenId: 'token',
			source: sealedSecretProviderInvocationSource,
			runtimeInvokeDepth: 0,
		}),
	).toBe(false)
})

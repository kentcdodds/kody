import { expect, test } from 'vitest'
import { packageWorkflowInvocationSource } from '#worker/package-runtime/package-invocation-sources.ts'
import {
	resolveInvocationMeteringSurface,
	resolveInvocationRuntimeName,
	resolveInvocationRuntimeSurface,
} from './common.ts'

test('invocation runtime surface and name map selectors without double-counting package workflows', () => {
	expect(
		resolveInvocationRuntimeSurface({
			selector: { kind: 'export', exportName: './run' },
			source: packageWorkflowInvocationSource,
		}),
	).toBeNull()
	expect(
		resolveInvocationRuntimeSurface({
			selector: { kind: 'export', exportName: './run' },
			source: 'discord-gateway',
		}),
	).toBe('export')
	expect(
		resolveInvocationRuntimeSurface({
			selector: { kind: 'subscription', topic: 'email.inbound' },
			source: 'email',
		}),
	).toBe('subscription')
	expect(
		resolveInvocationMeteringSurface({
			selector: { kind: 'export', exportName: './run' },
			source: packageWorkflowInvocationSource,
		}),
	).toBe('workflow')
	expect(
		resolveInvocationMeteringSurface({
			selector: { kind: 'export', exportName: './run' },
			source: 'discord-gateway',
		}),
	).toBe('export')

	expect(
		resolveInvocationRuntimeName({
			surface: 'subscription',
			invocationName: './on-email',
			topic: 'email.inbound',
		}),
	).toBe('email.inbound')
	expect(
		resolveInvocationRuntimeName({
			surface: 'export',
			invocationName: './run',
			topic: 'ignored',
		}),
	).toBe('./run')
})

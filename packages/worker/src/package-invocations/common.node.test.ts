import { expect, test } from 'vitest'
import { packageWorkflowInvocationSource } from '#worker/package-runtime/package-invocation-sources.ts'
import {
	resolveInvocationRuntimeName,
	resolveInvocationRuntimeSurface,
} from './common.ts'

test('resolveInvocationRuntimeSurface omits package-workflow so the outer workflow owns the run record', () => {
	expect(
		resolveInvocationRuntimeSurface({
			selector: { kind: 'export', exportName: './run' },
			source: packageWorkflowInvocationSource,
		}),
	).toBeNull()
})

test('resolveInvocationRuntimeSurface maps export and subscription selectors', () => {
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
})

test('resolveInvocationRuntimeName prefers topic for subscription surfaces', () => {
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

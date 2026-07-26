import { expect, test, vi } from 'vitest'

const sentryMock = vi.hoisted(() => ({
	isInitialized: vi.fn(() => true),
	setUser: vi.fn(),
	setTag: vi.fn(),
	setContext: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: (...args: Array<unknown>) => sentryMock.isInitialized(...args),
	setUser: (...args: Array<unknown>) => sentryMock.setUser(...args),
	setTag: (...args: Array<unknown>) => sentryMock.setTag(...args),
	setContext: (...args: Array<unknown>) => sentryMock.setContext(...args),
}))

const { applyDynamicWorkflowSentryScope } =
	await import('./package-workflows-sentry.ts')

test('applyDynamicWorkflowSentryScope tags package and inline workflows', () => {
	applyDynamicWorkflowSentryScope({
		instanceId: 'wf-instance-1',
		payload: {
			sourceType: 'package',
			userId: 'user-stable-1',
			packageId: 'pkg-1',
			kodyId: 'demo-package',
			sourceId: 'source-1',
			workflowName: 'nightly',
			exportName: 'run',
			idempotencyKey: 'idem-1',
			runAt: '2026-07-25T00:00:00.000Z',
			planDate: null,
		},
	})

	expect(sentryMock.setUser).toHaveBeenCalledWith({ id: 'user-stable-1' })
	expect(sentryMock.setTag).toHaveBeenCalledWith(
		'workflow.source_type',
		'package',
	)
	expect(sentryMock.setTag).toHaveBeenCalledWith(
		'workflow.kody_id',
		'demo-package',
	)
	expect(sentryMock.setContext).toHaveBeenCalledWith(
		'workflow',
		expect.objectContaining({
			instanceId: 'wf-instance-1',
			packageId: 'pkg-1',
			kodyId: 'demo-package',
			exportName: 'run',
			workflowName: 'nightly',
			idempotencyKey: 'idem-1',
		}),
	)

	sentryMock.setUser.mockClear()
	sentryMock.setTag.mockClear()
	sentryMock.setContext.mockClear()

	applyDynamicWorkflowSentryScope({
		instanceId: 'wf-inline-1',
		payload: {
			sourceType: 'inline',
			userId: 'user-stable-2',
			packageContext: null,
			workflowName: 'ad-hoc',
			code: 'export default async () => 1',
			idempotencyKey: 'idem-2',
			runAt: '2026-07-25T01:00:00.000Z',
			planDate: null,
		},
	})

	expect(sentryMock.setUser).toHaveBeenCalledWith({ id: 'user-stable-2' })
	expect(sentryMock.setTag).toHaveBeenCalledWith(
		'workflow.source_type',
		'inline',
	)
	expect(sentryMock.setTag).not.toHaveBeenCalledWith(
		'workflow.kody_id',
		expect.anything(),
	)
	expect(sentryMock.setContext).toHaveBeenCalledWith(
		'workflow',
		expect.objectContaining({
			instanceId: 'wf-inline-1',
			sourceType: 'inline',
			packageId: null,
			kodyId: null,
			codeBytes: 'export default async () => 1'.length,
		}),
	)
})

import { expect, test, vi } from 'vitest'

const spanCalls = vi.hoisted(() => ({
	spans: [] as Array<{
		name: string
		attributes: Record<string, boolean | number | string | undefined>
	}>,
}))

vi.mock('cloudflare:workers', () => ({
	tracing: {
		enterSpan(
			name: string,
			callback: (span: {
				isTraced: boolean
				setAttribute(key: string, value?: boolean | number | string): void
				end(): void
			}) => unknown,
		) {
			const attributes: Record<string, boolean | number | string | undefined> =
				{}
			spanCalls.spans.push({ name, attributes })
			return callback({
				isTraced: true,
				setAttribute(key, value) {
					attributes[key] = value
				},
				end() {},
			})
		},
	},
}))

const { recordUsage } = await import('./record-usage.ts')

test('recordUsage emits kody.usage spans with attributes and skips empty userId', async () => {
	spanCalls.spans.length = 0

	await recordUsage(
		{},
		{
			userId: 'user-1',
			eventType: 'execute',
			entityId: 'pkg-1',
			durationMs: 120,
			bytes: 512,
			outcome: 'error',
		},
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.execute',
			attributes: {
				'kody.user_id': 'user-1',
				'kody.event_type': 'execute',
				'kody.outcome': 'error',
				'kody.entity_id': 'pkg-1',
				'kody.duration_ms': 120,
				'kody.bytes': 512,
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{ userId: 'user-2', eventType: 'job_run', outcome: 'success' },
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.job_run',
			attributes: {
				'kody.user_id': 'user-2',
				'kody.event_type': 'job_run',
				'kody.outcome': 'success',
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{ userId: '', eventType: 'execute', outcome: 'success' },
	)
	expect(spanCalls.spans).toEqual([])
})

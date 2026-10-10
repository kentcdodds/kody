import { expect, test, vi } from 'vitest'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

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

const {
	automationSourceForAnalytics,
	recordUsage,
	usageAttributionFieldsFromRequest,
	usageEventBlobIndexes,
	usageEventBlobs,
} = await import('./record-usage.ts')

test('recordUsage emits kody.usage spans with attributes and skips empty userId', async () => {
	spanCalls.spans.length = 0

	await recordUsage(
		{},
		{
			userId: ownerIdFromStored('user-1'),
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
				'kody.actor_user_id': 'user-1',
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{
			userId: ownerIdFromStored('user-2'),
			eventType: 'job_run',
			outcome: 'success',
		},
	)
	expect(spanCalls.spans).toEqual([
		{
			name: 'kody.usage.job_run',
			attributes: {
				'kody.user_id': 'user-2',
				'kody.event_type': 'job_run',
				'kody.outcome': 'success',
				'kody.actor_user_id': 'user-2',
			},
		},
	])

	spanCalls.spans.length = 0
	await recordUsage(
		{},
		{ userId: ownerIdFromStored(''), eventType: 'execute', outcome: 'success' },
	)
	expect(spanCalls.spans).toEqual([])
})

test('usageEventBlobs default actor to org billing id and map automation sources', () => {
	const ts = '2026-09-01T00:00:00.000Z'
	expect(
		usageEventBlobs(
			{
				userId: ownerIdFromStored('org-1'),
				eventType: 'execute',
				outcome: 'success',
			},
			ts,
		)[usageEventBlobIndexes.actorUserId],
	).toBe('org-1')
	expect(
		usageEventBlobs(
			{
				userId: ownerIdFromStored('org-1'),
				eventType: 'job_run',
				outcome: 'success',
				actorUserId: '',
				automationSource: 'schedule',
			},
			ts,
		),
	).toEqual([
		'org-1',
		'job_run',
		'',
		'success',
		ts,
		'',
		'',
		'',
		'',
		'',
		'schedule',
	])
})

test('usageAttributionFieldsFromRequest maps user and automation runs', () => {
	const personId = personIdFromStored('a'.repeat(64))
	const user = {
		userId: personId,
		username: 'ada',
		email: 'ada@example.com',
		displayName: 'Ada',
	}
	expect(
		usageAttributionFieldsFromRequest(
			deriveRequestContext({ user, source: { kind: 'session' } }),
		),
	).toEqual({ actorUserId: personId, automationSource: '' })
	expect(
		usageAttributionFieldsFromRequest(
			deriveRequestContext({
				user,
				source: { kind: 'schedule', jobId: 'job-1' },
			}),
		),
	).toEqual({ actorUserId: '', automationSource: 'schedule' })
	expect(automationSourceForAnalytics('event')).toBe('')
})

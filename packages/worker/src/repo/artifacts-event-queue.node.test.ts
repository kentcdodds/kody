import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareArtifactsRepoEvent: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	processCloudflareArtifactsRepoEvent:
		mocks.processCloudflareArtifactsRepoEvent,
}))

const { handleArtifactsRepoEventsQueue } =
	await import('./artifacts-event-queue.ts')

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-05-18T20:00:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

test('artifacts repo events queue acks terminal outcomes and retries unmatched creates', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const dispatched = createQueueMessage('q-dispatched', { kind: 'dispatched' })
	const ignored = createQueueMessage('q-ignored', { kind: 'ignored' })
	const invalid = createQueueMessage('q-invalid', { kind: 'invalid' })
	const unmatchedPush = createQueueMessage('q-unmatched-push', {
		kind: 'unmatched-push',
	})
	const unmatchedDeleted = createQueueMessage('q-unmatched-deleted', {
		kind: 'unmatched-deleted',
	})
	const failed = createQueueMessage('q-failed', { kind: 'failed' })

	mocks.processCloudflareArtifactsRepoEvent.mockImplementation(
		async (input) => {
			const kind = (input.body as { kind: string }).kind
			switch (kind) {
				case 'dispatched':
					return {
						outcome: 'dispatched',
						providerEvent: { type: 'cf.artifacts.repo.pushed' },
						source: {},
					}
				case 'ignored':
					return {
						outcome: 'ignored',
						providerEvent: { type: 'cf.artifacts.repo.pushed' },
					}
				case 'invalid':
					return { outcome: 'invalid', providerEvent: null }
				case 'unmatched-push':
					return {
						outcome: 'unmatched',
						providerEvent: {
							type: 'cf.artifacts.repo.pushed',
							source: { repoName: 'repo-1', namespace: 'production' },
						},
					}
				case 'unmatched-deleted':
					return {
						outcome: 'unmatched',
						providerEvent: {
							type: 'cf.artifacts.repo.deleted',
							source: { repoName: 'repo-1', namespace: 'production' },
						},
					}
				case 'failed':
					throw new Error('boom')
				default:
					throw new Error(`unexpected ${kind}`)
			}
		},
	)

	await handleArtifactsRepoEventsQueue(
		{
			queue: 'kody-artifacts-repo-events',
			messages: [
				dispatched,
				ignored,
				invalid,
				unmatchedPush,
				unmatchedDeleted,
				failed,
			],
			ackAll: vi.fn(),
			retryAll: vi.fn(),
		} as unknown as MessageBatch<unknown>,
		{} as Env,
		{ waitUntil: vi.fn() } as unknown as ExecutionContext,
	)

	expect(dispatched.ack).toHaveBeenCalledTimes(1)
	expect(ignored.ack).toHaveBeenCalledTimes(1)
	expect(invalid.ack).toHaveBeenCalledTimes(1)
	expect(unmatchedPush.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(unmatchedDeleted.ack).toHaveBeenCalledTimes(1)
	expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
})

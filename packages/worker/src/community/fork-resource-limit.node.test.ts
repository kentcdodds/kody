import { expect, test } from 'vitest'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'
import {
	CommunityForkResourceLimitError,
	communityForkResourceLimitMessage,
	isCommunityForkResourceLimitCause,
	rethrowCommunityForkFailure,
} from './fork-resource-limit.ts'

test('isCommunityForkResourceLimitCause matches isolate reset and Artifacts MEMORY_LIMIT', () => {
	expect(
		isCommunityForkResourceLimitCause(
			new Error(durableObjectIsolateMemoryResetMessage),
		),
	).toBe(true)
	expect(
		isCommunityForkResourceLimitCause(
			new Error('publish failed', {
				cause: new Error(durableObjectIsolateMemoryResetMessage),
			}),
		),
	).toBe(true)
	expect(
		isCommunityForkResourceLimitCause(
			Object.assign(new Error('import exceeded service memory limits'), {
				code: 'MEMORY_LIMIT',
			}),
		),
	).toBe(true)
	expect(
		isCommunityForkResourceLimitCause(new Error('artifacts unavailable')),
	).toBe(false)
})

test('rethrowCommunityForkFailure wraps resource limits without leaking isolate text', () => {
	try {
		rethrowCommunityForkFailure(
			new Error(durableObjectIsolateMemoryResetMessage),
		)
		throw new Error('expected rethrow')
	} catch (error) {
		expect(error).toBeInstanceOf(CommunityForkResourceLimitError)
		expect((error as Error).message).toBe(communityForkResourceLimitMessage)
		expect((error as Error).message).not.toMatch(/isolate exceeded/)
	}

	expect(() => rethrowCommunityForkFailure(new Error('sync failed'))).toThrow(
		'sync failed',
	)
})

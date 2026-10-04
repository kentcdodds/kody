import { expect, test, vi } from 'vitest'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'
import {
	CommunityForkResourceLimitError,
	isCommunityForkResourceLimitCause,
	rethrowCommunityForkFailure,
} from './fork-resource-limit.ts'

test('isCommunityForkResourceLimitCause matches isolate reset and Artifacts MEMORY_LIMIT', () => {
	expect(
		isCommunityForkResourceLimitCause(
			new Error(
				"Durable Object's isolate exceeded its memory limit and was reset",
			),
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
		isCommunityForkResourceLimitCause(
			new Error('ArtifactsError: Memory limit exceeded during import'),
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
		expect((error as Error).message).toMatch(/too large to finish forking/)
		expect((error as Error).message).not.toMatch(/isolate exceeded/)
	}

	expect(() => rethrowCommunityForkFailure(new Error('sync failed'))).toThrow(
		'sync failed',
	)
})

test('rethrowCommunityForkFailure remaps Artifacts git transients to a reportable unavailable error', () => {
	const wrapped = new Error(
		'Artifacts git clone failed for https://acct.artifacts.cloudflare.net/git/production/repo.git: HTTP Error: 500 Internal Server Error',
	)
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		rethrowCommunityForkFailure(wrapped)
		throw new Error('expected rethrow')
	} catch (error) {
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).name).toBe('ArtifactsGitUnavailableError')
		expect((error as Error).message).toMatch(
			/^The package source could not be read after retries \(HTTP 5xx\)\. Report id: /,
		)
		expect((error as Error).cause).toBe(wrapped)
		expect((error as Error).message).not.toContain('artifacts.cloudflare.net')
		expect((error as Error).message).not.toContain('HTTP Error')
		expect((error as Error).message).not.toMatch(/temporarily unavailable/i)
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"message":"artifacts-git-unavailable"'),
		)
	} finally {
		errorSpy.mockRestore()
	}
})

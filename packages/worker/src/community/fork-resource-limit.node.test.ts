import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import { JobIntervalFloorError } from '#worker/entitlements/errors.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'
import { CommunityActionError } from './errors.ts'
import {
	type CommunityForkFailedStep,
	CommunityForkStepError,
} from './fork-failure.ts'
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

function captureRethrow(error: unknown, step: CommunityForkFailedStep) {
	try {
		rethrowCommunityForkFailure(error, { step, listingId: 'listing-1' })
	} catch (thrown) {
		return thrown
	}
	throw new Error('expected rethrow')
}

test('rethrowCommunityForkFailure wraps resource limits without leaking isolate text', () => {
	const error = captureRethrow(
		new Error(durableObjectIsolateMemoryResetMessage),
		'fork_row',
	)
	expect(error).toBeInstanceOf(CommunityForkResourceLimitError)
	expect((error as Error).message).toMatch(/too large to finish forking/)
	expect((error as Error).message).not.toMatch(/isolate exceeded/)
})

test('rethrowCommunityForkFailure passes caller-facing errors through unchanged', () => {
	const actionError = new CommunityActionError('listing changed')
	expect(captureRethrow(actionError, 'prepare')).toBe(actionError)
	const callerFacing = [
		new Error('outer', { cause: new McpCallerError('bad input') }),
		new JobIntervalFloorError({
			plan: 'free',
			minIntervalMs: 3_600_000,
		} as ConstructorParameters<typeof JobIntervalFloorError>[0]),
		new AccountDeletionInProgressError(),
	]
	for (const error of callerFacing) {
		expect(captureRethrow(error, 'install_projection')).toBe(error)
		expect(toApiError(error).code).not.toBe('internal_error')
	}
})

test('rethrowCommunityForkFailure tags unknown failures with step and report id', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const cause = new Error('sync failed')
		const error = captureRethrow(cause, 'sync_snapshot')
		expect(error).toBeInstanceOf(CommunityForkStepError)
		const stepError = error as CommunityForkStepError
		expect(stepError.cause).toBe(cause)
		expect(stepError.apiStatus).toBe(500)
		expect(stepError.message).toMatch(
			/^Internal error while forking\. Failed step: sync_snapshot; upstream status: unclassified\. Report id: [0-9a-f-]{36}\.$/,
		)
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"message":"community-fork-failed"'),
		)
		const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]))
		expect(logged).toMatchObject({
			reportId: stepError.reportId,
			step: 'sync_snapshot',
			listingId: 'listing-1',
			causes: ['sync failed'],
		})
	} finally {
		errorSpy.mockRestore()
	}
})

test('rethrowCommunityForkFailure keeps Artifacts git transients reportable without remotes', () => {
	const wrapped = new Error(
		'Artifacts git clone failed for https://acct.artifacts.cloudflare.net/git/production/repo.git: HTTP Error: 500 Internal Server Error',
	)
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const error = captureRethrow(wrapped, 'persist_forked_contents')
		expect(error).toBeInstanceOf(CommunityForkStepError)
		const stepError = error as CommunityForkStepError
		expect(stepError.message).toMatch(
			/^The package source could not be read after retries\. Failed step: persist_forked_contents \(git_clone\); upstream status: HTTP 500\. Report id: /,
		)
		expect(stepError.apiStatus).toBe(503)
		expect(stepError.toApiDetails()).toEqual({
			report_id: stepError.reportId,
			failed_step: 'persist_forked_contents',
			artifacts_operation: 'git_clone',
			upstream_status_class: 'http_5xx',
			upstream_status: 500,
		})
		expect(stepError.cause).toBe(wrapped)
		expect(stepError.message).not.toContain('artifacts.cloudflare.net')
		expect(stepError.message).not.toContain('HTTP Error')
	} finally {
		errorSpy.mockRestore()
	}
})

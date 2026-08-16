import { expect, test, vi } from 'vitest'
import {
	getArtifactsGitHttpStatus,
	isArtifactsGitPackfileCorruptionSentryMessage,
	isArtifactsGitTransientErrorMessage,
	isArtifactsGitTransientHttpErrorMessage,
	isIsomorphicGitPackfileCorruptionError,
	isTransientArtifactsGitError,
	isTransientArtifactsGitHttpError,
	isTransientArtifactsGitHttpStatus,
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'

function httpError(
	statusCode: number,
	statusMessage = 'Internal Server Error',
) {
	const error = new Error(
		`HTTP Error: ${statusCode} ${statusMessage}`,
	) as Error & {
		code: string
		name: string
		data: { statusCode: number; statusMessage: string; response: string }
	}
	error.code = 'HttpError'
	error.name = 'HttpError'
	error.data = { statusCode, statusMessage, response: '' }
	return error
}

function packfileCorruptionError() {
	const error = new Error(
		`An internal error caused this command to fail.\n\nIf you're using an application that depends on isomorphic-git, please report this error to that application's developers.\n\nIf you're a developer and you believe this is a bug in isomorphic-git, please file an issue at https://github.com/isomorphic-git/isomorphic-git/issues with a minimal reproduction, version and environment details, and this error message: Packfile payload corrupted: calculated abc but expected def. The packfile may have been tampered with.`,
	) as Error & { code: string; name: string }
	error.code = 'InternalError'
	error.name = 'InternalError'
	return error
}

test('Artifacts git HTTP helpers classify transient statuses, wrap messages, and retry then succeed', async () => {
	expect(isTransientArtifactsGitHttpStatus(429)).toBe(true)
	expect(isTransientArtifactsGitHttpStatus(500)).toBe(true)
	expect(isTransientArtifactsGitHttpStatus(503)).toBe(true)
	expect(isTransientArtifactsGitHttpStatus(400)).toBe(false)
	expect(isTransientArtifactsGitHttpStatus(401)).toBe(false)

	const fiveHundred = httpError(500)
	expect(getArtifactsGitHttpStatus(fiveHundred)).toBe(500)
	expect(isTransientArtifactsGitHttpError(fiveHundred)).toBe(true)
	expect(isTransientArtifactsGitHttpError(httpError(401, 'Unauthorized'))).toBe(
		false,
	)

	const wrapped = wrapArtifactsGitHttpError({
		operation: 'listServerRefs',
		remote:
			'https://x:secret@acct.artifacts.cloudflare.net/git/production/repo-1.git',
		error: fiveHundred,
	})
	expect(wrapped.message).toMatch(/^Artifacts listServerRefs failed for /)
	expect(wrapped.message).toContain('HTTP Error: 500')
	expect(wrapped.message).not.toContain('secret')
	expect(wrapped.cause).toBe(fiveHundred)
	expect(isArtifactsGitTransientHttpErrorMessage(wrapped.message)).toBe(true)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'Artifacts listServerRefs failed for https://example.test: HTTP Error: 401 Unauthorized',
		),
	).toBe(false)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'HTTP Error: 500 Internal Server Error',
		),
	).toBe(false)

	const wrappedWithQuery = wrapArtifactsGitHttpError({
		operation: 'git fetch',
		remote:
			'https://x:secret@acct.artifacts.cloudflare.net/git/production/repo-1.git?token=should-not-leak#frag',
		error: fiveHundred,
	})
	expect(wrappedWithQuery.message).toContain(
		'https://acct.artifacts.cloudflare.net/git/production/repo-1.git',
	)
	expect(wrappedWithQuery.message).not.toContain('token=')
	expect(wrappedWithQuery.message).not.toContain('secret')

	const operation = vi
		.fn()
		.mockRejectedValueOnce(httpError(500))
		.mockRejectedValueOnce(httpError(503))
		.mockResolvedValueOnce([{ ref: 'refs/heads/main', oid: 'abc' }])

	await expect(runArtifactsGitWithRetry(operation, [0, 0])).resolves.toEqual([
		{ ref: 'refs/heads/main', oid: 'abc' },
	])
	expect(operation).toHaveBeenCalledTimes(3)

	const authFailure = vi.fn().mockRejectedValue(httpError(401, 'Unauthorized'))
	await expect(runArtifactsGitWithRetry(authFailure, [0, 0])).rejects.toThrow(
		/HTTP Error: 401/,
	)
	expect(authFailure).toHaveBeenCalledTimes(1)

	const persistent = vi.fn().mockRejectedValue(httpError(500))
	await expect(runArtifactsGitWithRetry(persistent, [0, 0])).rejects.toThrow(
		/HTTP Error: 500/,
	)
	expect(persistent).toHaveBeenCalledTimes(3)
})

test('Artifacts git packfile corruption is transient, wrapped for git clone, and retried', async () => {
	const corruption = packfileCorruptionError()
	expect(isIsomorphicGitPackfileCorruptionError(corruption)).toBe(true)
	expect(isTransientArtifactsGitError(corruption)).toBe(true)
	expect(
		isTransientArtifactsGitError(new Error('unrelated InternalError')),
	).toBe(false)

	const wrapped = wrapArtifactsGitHttpError({
		operation: 'git clone',
		remote:
			'https://x:secret@acct.artifacts.cloudflare.net/git/production/repo-1.git',
		error: corruption,
	})
	expect(wrapped.message).toMatch(/^Artifacts git clone failed for /)
	expect(wrapped.message).toContain('Packfile payload corrupted')
	expect(wrapped.message).not.toContain('secret')
	expect(isArtifactsGitTransientErrorMessage(wrapped.message)).toBe(true)
	expect(
		isArtifactsGitPackfileCorruptionSentryMessage(corruption.message),
	).toBe(true)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'Artifacts git clone failed for https://example.test: HTTP Error: 500',
		),
	).toBe(true)

	const operation = vi
		.fn()
		.mockRejectedValueOnce(corruption)
		.mockResolvedValueOnce({ cloned: true })
	await expect(runArtifactsGitWithRetry(operation, [0, 0])).resolves.toEqual({
		cloned: true,
	})
	expect(operation).toHaveBeenCalledTimes(2)

	const persistent = vi.fn().mockRejectedValue(corruption)
	await expect(runArtifactsGitWithRetry(persistent, [0, 0])).rejects.toThrow(
		/Packfile payload corrupted/,
	)
	expect(persistent).toHaveBeenCalledTimes(3)
})

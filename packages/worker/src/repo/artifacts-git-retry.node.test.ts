import { expect, test, vi } from 'vitest'
import {
	getArtifactsGitHttpStatus,
	isArtifactsGitTransientHttpErrorMessage,
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
	expect(wrapped.message).toBe(
		'Artifacts listServerRefs failed for https://acct.artifacts.cloudflare.net/git/production/repo-1.git: HTTP Error: 500 Internal Server Error',
	)
	expect(wrapped.cause).toBe(fiveHundred)
	expect(isArtifactsGitTransientHttpErrorMessage(wrapped.message)).toBe(true)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'Artifacts git fetch failed for https://acct.artifacts.cloudflare.net/git/production/repo-1.git: HTTP Error: 502 Bad Gateway',
		),
	).toBe(true)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'Artifacts listServerRefs failed for https://example.test: HTTP Error: 501 Not Implemented',
		),
	).toBe(false)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'Artifacts listServerRefs failed for https://example.test: HTTP Error: 505 HTTP Version Not Supported',
		),
	).toBe(false)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'HTTP Error: 500 Internal Server Error',
		),
	).toBe(false)
	expect(
		isArtifactsGitTransientHttpErrorMessage(
			'Artifacts listServerRefs failed for https://example.test: HTTP Error: 401 Unauthorized',
		),
	).toBe(false)

	const wrappedWithQuery = wrapArtifactsGitHttpError({
		operation: 'git fetch',
		remote:
			'https://x:secret@acct.artifacts.cloudflare.net/git/production/repo-1.git?token=should-not-leak#frag',
		error: fiveHundred,
	})
	expect(wrappedWithQuery.message).toBe(
		'Artifacts git fetch failed for https://acct.artifacts.cloudflare.net/git/production/repo-1.git: HTTP Error: 500 Internal Server Error',
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

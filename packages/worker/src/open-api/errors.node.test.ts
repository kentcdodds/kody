import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { expect, test } from 'vitest'
import { wrapArtifactsGitHttpError } from '#worker/repo/artifacts-git-retry.ts'
import {
	ApiError,
	artifactsGitTemporarilyUnavailableMessage,
	toApiError,
} from './errors.ts'

test('ApiError.toBody redacts Kody credentials in error details', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const bootstrapCode = `kody_bc_${'b'.repeat(16)}_${'C'.repeat(32)}`

	const body = new ApiError({
		status: 400,
		code: 'invalid_request',
		message: 'Invalid details.',
		details: {
			credentials: [apiToken, { nested: `failed with ${bootstrapCode}` }],
		},
	}).toBody()

	expect(body.error.details).toEqual({
		credentials: [
			'kody_at_[redacted]',
			{ nested: 'failed with kody_bc_[redacted]' },
		],
	})
})

function artifactsGitHttpError(statusCode: number) {
	const error = new Error(
		`HTTP Error: ${statusCode} Internal Server Error`,
	) as Error & {
		code: string
		name: string
		data: { statusCode: number; statusMessage: string; response: string }
	}
	error.code = 'HttpError'
	error.name = 'HttpError'
	error.data = {
		statusCode,
		statusMessage: 'Internal Server Error',
		response: '',
	}
	return error
}

test('toApiError maps transient Artifacts git failures to 503 internal_error with a sanitized retry message', () => {
	const remote =
		'https://x:secret@acct.artifacts.cloudflare.net/git/production/repo-1.git'
	const wrapped = wrapArtifactsGitHttpError({
		operation: 'git clone',
		remote,
		error: artifactsGitHttpError(500),
	})

	const apiError = toApiError(wrapped)

	expect(apiError).toMatchObject({
		status: 503,
		code: 'internal_error',
		message: artifactsGitTemporarilyUnavailableMessage,
	})
	expect(apiError.cause).toBe(wrapped)
	expect(apiError.message).not.toContain('secret')
	expect(apiError.message).not.toContain('artifacts.cloudflare.net')
	expect(apiError.message).not.toContain('HTTP Error')
	// Not a caller error — MCP api marks callerError from status < 500.
	expect(apiError.status).toBeGreaterThanOrEqual(500)
	expect(apiError.toBody()).toEqual({
		error: {
			code: 'internal_error',
			message: artifactsGitTemporarilyUnavailableMessage,
		},
	})
})

test('toApiError keeps non-transient internal failures as generic 500', () => {
	const original = new Error('unexpected storage corruption')
	const apiError = toApiError(original)

	expect(apiError).toMatchObject({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
	})
	expect(apiError.cause).toBe(original)
	expect(getErrorMessage(apiError.cause)).toBe('unexpected storage corruption')
})

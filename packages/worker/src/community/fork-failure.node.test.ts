import { expect, test, vi } from 'vitest'
import { CloudflareApiError } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import {
	type ArtifactNamespaceBinding,
	ensureArtifactRepoReady,
} from '#worker/repo/artifacts.ts'
import { tagArtifactsFailure } from '#worker/repo/artifacts-failure-tag.ts'
import {
	classifyCommunityForkUpstream,
	CommunityForkStepError,
	toCommunityForkStepError,
} from './fork-failure.ts'

function createBinding(
	overrides: Partial<ArtifactNamespaceBinding>,
): ArtifactNamespaceBinding {
	return {
		create: vi.fn(),
		fork: vi.fn(),
		get: vi.fn(async () => ({ status: 'not_found' as const })),
		delete: vi.fn(),
		list: vi.fn(),
		repo: vi.fn(),
		...overrides,
	} as unknown as ArtifactNamespaceBinding
}

async function captureRejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		return error
	}
	throw new Error('expected rejection')
}

test('get-after-create ghost conflicts classify as get_after_create / not_found', async () => {
	const binding = createBinding({
		create: vi.fn(async () => {
			throw new Error('ArtifactsError: Repository already exists: repo-1')
		}),
	})
	vi.useFakeTimers()
	try {
		const pending = captureRejection(
			ensureArtifactRepoReady({} as Env, 'repo-1', binding),
		)
		await vi.runAllTimersAsync()
		const error = await pending
		expect(classifyCommunityForkUpstream(error)).toEqual({
			operation: 'get_after_create',
			statusClass: 'not_found',
			httpStatus: null,
		})
	} finally {
		vi.useRealTimers()
	}
})

test('create failures classify as repo_create with the REST HTTP status', async () => {
	const binding = createBinding({
		create: vi.fn(async () => {
			throw new CloudflareApiError('Artifacts upstream failed', {
				status: 502,
			})
		}),
	})
	const error = await captureRejection(
		ensureArtifactRepoReady({} as Env, 'repo-1', binding),
	)
	expect(classifyCommunityForkUpstream(error)).toEqual({
		operation: 'repo_create',
		statusClass: 'http_5xx',
		httpStatus: 502,
	})
})

test('tags on an inner cause survive outer wrapping', () => {
	const inner = tagArtifactsFailure(new Error('Create failed'), {
		operation: 'repo_create',
		httpStatus: 429,
	})
	expect(
		classifyCommunityForkUpstream(new Error('outer', { cause: inner })),
	).toEqual({
		operation: 'repo_create',
		statusClass: 'http_429',
		httpStatus: 429,
	})
})

test('toApiError keeps internal_error and adds step details for fork failures', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const cause = tagArtifactsFailure(
			new Error('Artifacts repo "repo-1" is not_found after create conflict.'),
			{ operation: 'get_after_create' },
		)
		const stepError = toCommunityForkStepError(cause, {
			step: 'fallback_ensure_source',
			listingId: 'listing-1',
			packageId: 'package-1',
		})
		expect(stepError).toBeInstanceOf(CommunityForkStepError)
		expect(stepError.message).toBe(
			`Internal error while forking. Failed step: fallback_ensure_source (get_after_create); upstream status: repo not found. Report id: ${stepError.reportId}.`,
		)
		expect(stepError.message).not.toContain('repo-1')
		const apiError = toApiError(stepError)
		expect(apiError.status).toBe(500)
		expect(apiError.code).toBe('internal_error')
		expect(apiError.toBody()).toEqual({
			error: {
				code: 'internal_error',
				message: stepError.message,
				details: {
					report_id: stepError.reportId,
					failed_step: 'fallback_ensure_source',
					artifacts_operation: 'get_after_create',
					upstream_status_class: 'not_found',
				},
			},
		})
		expect(toApiError(new Error('outer', { cause: stepError })).message).toBe(
			stepError.message,
		)
		expect(toCommunityForkStepError(stepError, { step: 'fork_row' })).toBe(
			stepError,
		)
		expect(errorSpy).toHaveBeenCalledTimes(1)
	} finally {
		errorSpy.mockRestore()
	}
})

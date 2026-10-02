import { expect, test } from 'vitest'
import {
	cloudflareArtifactsOpaqueInternalErrorMessage,
	isCloudflareOpaqueInternalError,
	isCloudflareOpaqueInternalErrorMessage,
} from './cloudflare-opaque-internal-error.ts'

test('opaque Cloudflare / Artifacts matching normalizes prefixes and reads non-Error shapes', () => {
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			`Error: ${cloudflareArtifactsOpaqueInternalErrorMessage}`,
		),
	).toBe(true)
	expect(
		isCloudflareOpaqueInternalErrorMessage('An unexpected internal error'),
	).toBe(false)
	expect(isCloudflareOpaqueInternalErrorMessage('internal error')).toBe(false)

	const nativeArtifactsError = {
		name: 'ArtifactsError',
		code: 'INTERNAL_ERROR',
		message: cloudflareArtifactsOpaqueInternalErrorMessage,
	}
	expect(isCloudflareOpaqueInternalError(nativeArtifactsError)).toBe(true)
	expect(
		isCloudflareOpaqueInternalError(
			new Error('wrapper', { cause: nativeArtifactsError }),
		),
	).toBe(true)
	expect(
		isCloudflareOpaqueInternalError({
			name: 'ArtifactsError',
			code: 'INTERNAL_ERROR',
			message: 'Repository not found: demo',
		}),
	).toBe(false)
	expect(
		isCloudflareOpaqueInternalError({
			name: 'ArtifactsError',
			code: 'INTERNAL_ERROR',
		}),
	).toBe(false)
})

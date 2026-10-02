import { expect, test } from 'vitest'
import {
	cloudflareArtifactsOpaqueInternalErrorMessage,
	cloudflareOpaqueInternalErrorMessage,
	isCloudflareOpaqueInternalError,
	isCloudflareOpaqueInternalErrorMessage,
} from './cloudflare-opaque-internal-error.ts'

test('opaque Cloudflare / Artifacts matching keeps exact bare sentences', () => {
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			cloudflareOpaqueInternalErrorMessage,
		),
	).toBe(true)
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			cloudflareArtifactsOpaqueInternalErrorMessage,
		),
	).toBe(true)
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			`Error: ${cloudflareArtifactsOpaqueInternalErrorMessage}`,
		),
	).toBe(true)
	expect(
		isCloudflareOpaqueInternalErrorMessage('An unexpected internal error'),
	).toBe(false)
	expect(isCloudflareOpaqueInternalErrorMessage('internal error')).toBe(false)
})

test('opaque matching reads validated message on non-Error ArtifactsError shapes', () => {
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

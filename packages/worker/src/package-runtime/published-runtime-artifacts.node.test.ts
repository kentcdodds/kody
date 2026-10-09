import { expect, test } from 'vitest'
import { isUsableStoredPublishedBundleArtifact } from './published-runtime-artifacts.ts'

test('isUsableStoredPublishedBundleArtifact keeps clean v1 payloads and rejects remix-injected ones', () => {
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: { 'dist/out.js': 'export default {}' },
		}),
	).toBe(true)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 2,
			modules: { 'dist/out.js': 'export default {}' },
		}),
	).toBe(false)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: { 'dist/out.js': 'export default {}' },
			remixVersion: '3.0.0',
		}),
	).toBe(false)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: { 'dist/out.js': 'export default {}' },
			remixUiVersion: '0.12.1',
		}),
	).toBe(false)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: null,
		}),
	).toBe(false)
})

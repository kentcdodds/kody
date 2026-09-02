import { expect, test } from 'vitest'
import {
	readPackageManifestVersion,
	resolveListingPackageVersion,
} from './package-version.ts'

test('readPackageManifestVersion accepts a string version and rejects the rest', () => {
	expect(readPackageManifestVersion('{"version":"1.0.4"}')).toBe('1.0.4')
	expect(readPackageManifestVersion('{"version":"  1.0.4-beta.1  "}')).toBe(
		'1.0.4-beta.1',
	)
	expect(readPackageManifestVersion('{"version":1}')).toBeNull()
	expect(readPackageManifestVersion('{"version":""}')).toBeNull()
	expect(readPackageManifestVersion('{"version":"1 0"}')).toBeNull()
	expect(readPackageManifestVersion('{"name":"@a/b"}')).toBeNull()
	expect(readPackageManifestVersion('{')).toBeNull()
	expect(readPackageManifestVersion(null)).toBeNull()
	expect(
		readPackageManifestVersion(`{"version":"${'x'.repeat(65)}"}`),
	).toBeNull()
	expect(
		resolveListingPackageVersion({
			stored: '1.0.3',
			packageJson: '{"version":"1.0.4"}',
		}),
	).toBe('1.0.3')
	expect(
		resolveListingPackageVersion({
			stored: null,
			packageJson: '{"version":"1.0.4"}',
		}),
	).toBe('1.0.4')
})

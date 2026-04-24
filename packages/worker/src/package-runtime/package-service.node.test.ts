import { expect, test } from 'vitest'
import { buildPackageServiceStorageId } from './package-service.ts'

test('buildPackageServiceStorageId creates stable per-service storage ids', () => {
	expect(buildPackageServiceStorageId('package-1', 'discord-gateway')).toBe(
		'service:package-1:discord-gateway',
	)
	expect(buildPackageServiceStorageId('package-1', 'guild sync')).toBe(
		'service:package-1:guild%20sync',
	)
})

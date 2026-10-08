import { expect, test } from 'vitest'
import { listPackageManifestExportNames } from './package-token-export-selection.ts'

test('listPackageManifestExportNames normalizes names and skips the token wildcard', () => {
	expect(
		listPackageManifestExportNames({
			'.': './src/index.ts',
			'./dispatch-message-created': './src/dispatch.ts',
			'dispatch-event': './src/dispatch-event.ts',
			'*': './src/star.ts',
			'': './src/empty.ts',
		}),
	).toEqual(['.', './dispatch-event', './dispatch-message-created'])
})

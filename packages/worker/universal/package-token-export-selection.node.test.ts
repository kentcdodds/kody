import { expect, test } from 'vitest'
import {
	applyPackageTokenExportSelection,
	formatPackageTokenExportChoiceLabel,
	isPackageTokenWildcardSelected,
	listPackageManifestExportNames,
	listPackageTokenExportChoices,
	packageTokenWildcardExport,
	parsePackageTokenExportSelection,
	tryNormalizePackageTokenExportName,
} from './package-token-export-selection.ts'

test('package token export selection normalizes names, wildcard exclusivity, and stale choices', () => {
	expect(tryNormalizePackageTokenExportName('')).toBe(null)
	expect(tryNormalizePackageTokenExportName('   ')).toBe(null)
	expect(tryNormalizePackageTokenExportName('*')).toBe(
		packageTokenWildcardExport,
	)
	expect(tryNormalizePackageTokenExportName('dispatch-event')).toBe(
		'./dispatch-event',
	)
	expect(tryNormalizePackageTokenExportName('./dispatch-event')).toBe(
		'./dispatch-event',
	)
	expect(tryNormalizePackageTokenExportName('.')).toBe('.')
	expect(tryNormalizePackageTokenExportName('./')).toBe('.')

	expect(
		parsePackageTokenExportSelection([
			'dispatch-event',
			'./process-video',
			'dispatch-event',
			'',
		]),
	).toEqual(['./dispatch-event', './process-video'])
	expect(
		parsePackageTokenExportSelection([
			'dispatch-event',
			'*',
			'./process-video',
		]),
	).toEqual([packageTokenWildcardExport])

	expect(
		applyPackageTokenExportSelection({
			current: ['./dispatch-event'],
			exportName: '*',
			selected: true,
		}),
	).toEqual([packageTokenWildcardExport])
	expect(
		applyPackageTokenExportSelection({
			current: [packageTokenWildcardExport],
			exportName: '*',
			selected: false,
		}),
	).toEqual([])
	expect(
		applyPackageTokenExportSelection({
			current: [packageTokenWildcardExport],
			exportName: 'process-video',
			selected: true,
		}),
	).toEqual(['./process-video'])
	expect(
		applyPackageTokenExportSelection({
			current: ['./dispatch-event', './process-video'],
			exportName: './dispatch-event',
			selected: false,
		}),
	).toEqual(['./process-video'])
	expect(
		applyPackageTokenExportSelection({
			current: ['./process-video'],
			exportName: 'dispatch-event',
			selected: true,
		}),
	).toEqual(['./process-video', './dispatch-event'])

	expect(
		listPackageTokenExportChoices({
			packageExports: ['./process-video', '.', 'dispatch-event'],
			selected: ['*', './retired-export', 'process-video'],
		}),
	).toEqual(['.', './dispatch-event', './process-video', './retired-export'])
	expect(
		listPackageTokenExportChoices({
			packageExports: null,
			selected: ['*', './retired-export'],
		}),
	).toEqual(['./retired-export'])
	expect(
		listPackageManifestExportNames({
			'.': './src/index.ts',
			'./dispatch-message-created': './src/dispatch.ts',
			'*': './src/star.ts',
		}),
	).toEqual(['.', './dispatch-message-created'])

	expect(isPackageTokenWildcardSelected(['*'])).toBe(true)
	expect(isPackageTokenWildcardSelected(['./process-video'])).toBe(false)
	expect(formatPackageTokenExportChoiceLabel('.')).toBe('. (root export)')
	expect(formatPackageTokenExportChoiceLabel('./process-video')).toBe(
		'./process-video',
	)
})

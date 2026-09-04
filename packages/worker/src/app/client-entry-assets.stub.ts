import { mergeAssets, type ImportedAssets } from '@pitlane/dev/runtime'

const fallbackAssets: ImportedAssets = {
	entry: '/client-entry.js',
	js: [],
	css: [],
	merge(...results) {
		return mergeAssets(fallbackAssets, ...results)
	},
}

export function getClientEntryAssets(_pathname: string): ImportedAssets {
	return fallbackAssets
}

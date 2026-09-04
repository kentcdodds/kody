import { mergeAssets, type ImportedAssets } from '@pitlane/dev/runtime'

/**
 * Default client-asset map for Wrangler-bundled graphs (MCP e2e, leftover
 * wrangler-env) and Vitest. Vite aliases this module to
 * `client-entry-assets.vite.ts`, which uses Pitlane `?assets=` imports.
 */
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

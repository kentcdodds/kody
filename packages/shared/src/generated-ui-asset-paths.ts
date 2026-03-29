export const generatedUiRuntimeScriptPath = '/mcp-apps/kody-ui-utils.js'
export const generatedUiRuntimeStylesheetPath = '/mcp-apps/kody-ui-utils.css'

export function resolveGeneratedUiAssetUrl(
	assetPath: string,
	baseUrl: string | URL | null | undefined,
) {
	if (!baseUrl) {
		return assetPath
	}

	try {
		return new URL(assetPath, baseUrl).toString()
	} catch {
		return assetPath
	}
}

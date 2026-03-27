export const generatedUiShellScriptPath = '/mcp-apps/generated-ui-shell.js'
export const generatedUiRuntimeStylesheetPath = '/mcp-apps/generated-ui-runtime.css'

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

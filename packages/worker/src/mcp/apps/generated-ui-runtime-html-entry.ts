import {
	generatedUiRuntimeScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'
import { escapeInlineScriptSource } from '@kody-internal/shared/generated-ui-documents.ts'
import {
	buildGeneratedUiRuntimeImportMap,
	type GeneratedUiRuntimeBootstrap,
} from '#client/mcp-apps/generated-ui-runtime-contract.ts'

export const generatedUiRuntimeResourceUri =
	'ui://generated-ui-runtime/entry-point.html' as const

export function renderGeneratedUiRuntimeHtmlEntry(baseUrl: string | URL) {
	const runtimeScriptHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		baseUrl,
	)
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		baseUrl,
	)
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'entry',
	}
	const bootstrapJson = escapeInlineScriptSource(JSON.stringify(bootstrap))

	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Generated UI Runtime</title>
		<link rel="stylesheet" href="${stylesheetHref}" />
		<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
		</script>
		${buildGeneratedUiRuntimeImportMap(runtimeScriptHref)}
	</head>
	<body data-kody-runtime="fragment">
		<div id="app" data-generated-ui-root></div>
		<script type="module" src="${runtimeScriptHref}" crossorigin="anonymous"></script>
	</body>
</html>
`.trim()
}

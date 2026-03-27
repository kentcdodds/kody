import {
	generatedUiShellScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'
import { escapeInlineScriptSource } from '@kody-internal/shared/generated-ui-documents.ts'
import { type GeneratedUiRuntimeBootstrap } from '@kody-internal/shared/generated-ui-runtime-types.ts'

export const generatedUiShellResourceUri =
	'ui://generated-ui-shell/entry-point.html' as const

export function renderGeneratedUiShellEntryPoint(baseUrl: string | URL) {
	const shellScriptHref = resolveGeneratedUiAssetUrl(
		generatedUiShellScriptPath,
		baseUrl,
	)
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		baseUrl,
	)
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'shell',
	}
	const bootstrapJson = escapeInlineScriptSource(JSON.stringify(bootstrap))

	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Generated UI Shell</title>
		<link rel="stylesheet" href="${stylesheetHref}" />
		<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
		</script>
	</head>
	<body data-kody-runtime="fragment">
		<div id="app" data-generated-ui-root></div>
		<script type="module" src="${shellScriptHref}" crossorigin="anonymous"></script>
	</body>
</html>
`.trim()
}

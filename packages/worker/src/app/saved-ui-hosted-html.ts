import { renderGeneratedUiDocument } from '@kody-internal/shared/generated-ui-documents.ts'
import {
	generatedUiRuntimeScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'
import { type GeneratedUiRuntimeBootstrap } from '#client/mcp-apps/generated-ui-runtime-controller.ts'
import { type GeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'

type HostedSavedUiInput = {
	artifact: UiArtifactRow
	appSession: GeneratedUiAppSession
	appBaseUrl: string
}

export function renderHostedSavedUiHtml(input: HostedSavedUiInput) {
	const runtime =
		input.artifact.runtime === 'javascript' ? 'javascript' : 'html'
	return renderGeneratedUiDocument({
		code: input.artifact.code,
		runtime,
		headInjection: buildHeadInjection(input.appSession, input.appBaseUrl),
		baseHref: input.appBaseUrl,
	})
}

function buildHeadInjection(
	appSession: GeneratedUiAppSession,
	appBaseUrl: string,
) {
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'hosted',
		appSession: {
			token: appSession.token,
			endpoints: appSession.endpoints,
		},
	}
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		appBaseUrl,
	)
	const runtimeScriptSrc = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		appBaseUrl,
	)
	const bootstrapJson = JSON.stringify(bootstrap).replace(
		/<\/script/gi,
		'<\\/script',
	)
	return `
<link rel="stylesheet" href="${stylesheetHref}" />
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
</script>
<script src="${runtimeScriptSrc}"></script>
	`.trim()
}

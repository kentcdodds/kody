import { renderGeneratedUiDocument } from '@kody-internal/shared/generated-ui-documents.ts'
import {
	generatedUiRuntimeScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'
import {
	buildGeneratedUiRuntimeImportMap,
	injectGeneratedUiBootstrapScript,
	type GeneratedUiAppBackendBootstrap,
	type GeneratedUiRuntimeBootstrap,
} from '#client/mcp-apps/kody-ui-utils-contract.ts'
import {
	buildSavedAppBackendBasePath,
	type GeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'
import {
	hasUiArtifactServerCode,
	type UiArtifactRow,
} from '#mcp/ui-artifacts-types.ts'
import { type ResolvedSavedAppSource } from '#worker/repo/app-source.ts'

type HostedSavedUiInput = {
	artifact: Pick<UiArtifactRow, 'id'> & ResolvedSavedAppSource
	appSession: GeneratedUiAppSession
	appBaseUrl: string
}

export function renderHostedSavedUiHtml(input: HostedSavedUiInput) {
	return renderGeneratedUiDocument({
		code: input.artifact.clientCode,
		runtime: 'html',
		headInjection: buildHeadInjection(
			input.artifact,
			input.appSession,
			input.appBaseUrl,
		),
		baseHref: input.appBaseUrl,
	})
}

function buildHeadInjection(
	artifact: Pick<UiArtifactRow, 'id'> & ResolvedSavedAppSource,
	appSession: GeneratedUiAppSession,
	appBaseUrl: string,
) {
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'hosted',
		appSession: {
			token: appSession.token,
			endpoints: appSession.endpoints,
		},
		appBackend: buildAppBackendBootstrap(artifact),
	}
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		appBaseUrl,
	)
	const runtimeScriptSrc = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		appBaseUrl,
	)
	return `
<link rel="stylesheet" href="${stylesheetHref}" />
${injectGeneratedUiBootstrapScript(bootstrap)}
${buildGeneratedUiRuntimeImportMap(runtimeScriptSrc)}
<script type="module" src="${runtimeScriptSrc}"></script>
	`.trim()
}

function buildAppBackendBootstrap(
	artifact: Pick<UiArtifactRow, 'id'> & ResolvedSavedAppSource,
): GeneratedUiAppBackendBootstrap | null {
	if (!hasUiArtifactServerCode(Boolean(artifact.serverCode))) {
		return null
	}
	return {
		basePath: buildSavedAppBackendBasePath(artifact.id),
		facetNames: ['main'],
	}
}

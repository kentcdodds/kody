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
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type ResolvedSavedAppSource } from '#worker/repo/app-source.ts'

type HostedSavedUiInput = {
	artifact: UiArtifactRow
	resolvedArtifact: Pick<ResolvedSavedAppSource, 'clientCode' | 'serverCode'>
	appSession: GeneratedUiAppSession
	appBaseUrl: string
}

export function renderHostedSavedUiHtml(input: HostedSavedUiInput) {
	return renderGeneratedUiDocument({
		code: input.resolvedArtifact.clientCode,
		runtime: 'html',
		headInjection: buildHeadInjection(
			input.artifact.id,
			input.resolvedArtifact,
			input.appSession,
			input.appBaseUrl,
		),
		baseHref: input.appBaseUrl,
	})
}

function buildHeadInjection(
	appId: string,
	resolvedArtifact: Pick<ResolvedSavedAppSource, 'clientCode' | 'serverCode'>,
	appSession: GeneratedUiAppSession,
	appBaseUrl: string,
) {
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'hosted',
		appSession: {
			token: appSession.token,
			endpoints: appSession.endpoints,
		},
		appBackend: buildAppBackendBootstrap({
			appId,
			resolvedArtifact,
		}),
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

function buildAppBackendBootstrap(input: {
	appId: string
	resolvedArtifact: Pick<ResolvedSavedAppSource, 'serverCode'>
}): GeneratedUiAppBackendBootstrap | null {
	if (input.resolvedArtifact.serverCode == null) {
		return null
	}
	return {
		basePath: buildSavedAppBackendBasePath(input.appId),
		facetNames: ['main'],
	}
}

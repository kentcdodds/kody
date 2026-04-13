/// <reference lib="dom" />
import { escapeInlineScriptSource } from '@kody-internal/shared/generated-ui-documents.ts'

export type GeneratedUiStorageScope = 'session' | 'app' | 'user'

export type GeneratedUiSecretMetadata = {
	name: string
	scope: GeneratedUiStorageScope
	description: string
	app_id: string | null
	allowed_hosts: Array<string>
	created_at: string
	updated_at: string
	ttl_ms: number | null
}

export type GeneratedUiValueMetadata = {
	name: string
	scope: GeneratedUiStorageScope
	value: string
	description: string
	app_id: string | null
	created_at: string
	updated_at: string
	ttl_ms: number | null
}

export type GeneratedUiSessionEndpoints = {
	source: string
	execute: string
	secrets: string
	deleteSecret: string
}

export type GeneratedUiAppSessionBootstrap = {
	token?: string
	endpoints: GeneratedUiSessionEndpoints
}

export type GeneratedUiAppBackendBootstrap = {
	basePath: string
	facetNames?: Array<string>
}

export type GeneratedUiRuntimeBootstrap = {
	mode: 'entry' | 'hosted' | 'mcp'
	params?: Record<string, unknown>
	appSession?: GeneratedUiAppSessionBootstrap | null
	appBackend?: GeneratedUiAppBackendBootstrap | null
}

export const generatedUiRuntimeModuleSpecifier = '@kody/ui-utils' as const

export function buildGeneratedUiRuntimeImportMap(runtimeScriptHref: string) {
	const importMapJson = escapeInlineScriptSource(
		JSON.stringify({
			imports: {
				[generatedUiRuntimeModuleSpecifier]: runtimeScriptHref,
			},
		}),
	)
	return `<script type="importmap">${importMapJson}</script>`
}

export function injectGeneratedUiBootstrapScript(
	bootstrap: GeneratedUiRuntimeBootstrap,
) {
	const bootstrapJson = escapeInlineScriptSource(JSON.stringify(bootstrap))
	return `
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
window.__kodyAppParams = window.__kodyGeneratedUiBootstrap.params ?? {};
window.params = window.__kodyAppParams;
</script>
	`.trim()
}

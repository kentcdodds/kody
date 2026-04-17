import { expect, test } from 'vitest'
import { renderHostedSavedUiHtml } from './saved-ui-hosted-html.ts'

const appSession = {
	sessionId: 'session-123',
	token: 'token-123',
	expiresAt: '2026-03-27T00:00:00.000Z',
	endpoints: {
		source: 'https://kody.example/ui-api/session-123/source',
		execute: 'https://kody.example/ui-api/session-123/execute',
		secrets: 'https://kody.example/ui-api/session-123/secrets',
		deleteSecret: 'https://kody.example/ui-api/session-123/secrets/delete',
	},
}

test('renderHostedSavedUiHtml emits shared runtime assets for apps without backends', () => {
	const result = renderHostedSavedUiHtml({
		artifact: {
			id: 'app-123',
			user_id: 'user-123',
			title: 'Hosted App',
			description: 'Hosted generated UI app',
			sourceId: 'source-app-123',
			parameters: null,
			hidden: true,
			created_at: '2026-03-27T00:00:00.000Z',
			updated_at: '2026-03-27T00:00:00.000Z',
		},
		resolvedArtifact: {
			clientCode: '<main>Hello</main>',
			serverCode: null,
		},
		appSession,
		appBaseUrl: 'https://kody.example',
	})

	expect(result).toContain(
		'<link rel="stylesheet" href="https://kody.example/mcp-apps/kody-ui-utils.css" />',
	)
	expect(result).toContain(
		'<script type="module" src="https://kody.example/mcp-apps/kody-ui-utils.js"></script>',
	)
	expect(result).toContain('<main>Hello</main>')

	const bootstrapMatch = result.match(
		/window\.__kodyGeneratedUiBootstrap = ([^;]+);/,
	)
	expect(bootstrapMatch).not.toBeNull()
	const bootstrap = JSON.parse(bootstrapMatch?.[1] ?? '{}') as {
		mode?: string
		appBackend?: { basePath?: string }
	}
	expect(bootstrap.mode).toBe('hosted')
	expect(bootstrap.appBackend).toBeNull()
})

test('renderHostedSavedUiHtml includes backend bootstrap for apps with server code', () => {
	const result = renderHostedSavedUiHtml({
		artifact: {
			id: 'app-456',
			user_id: 'user-123',
			title: 'Hosted JS App',
			description: 'Hosted generated UI javascript app',
			sourceId: 'source-app-456',
			parameters: null,
			hidden: true,
			created_at: '2026-03-27T00:00:00.000Z',
			updated_at: '2026-03-27T00:00:00.000Z',
		},
		resolvedArtifact: {
			clientCode:
				'<!doctype html><html><body><main data-app-root="true">hello</main></body></html>',
			serverCode:
				'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject {}',
		},
		appSession,
		appBaseUrl: 'https://kody.example',
	})

	expect(result).toContain('<main data-app-root="true">hello</main>')
	const bootstrapMatch = result.match(
		/window\.__kodyGeneratedUiBootstrap = ([^;]+);/,
	)
	expect(bootstrapMatch).not.toBeNull()
	const bootstrap = JSON.parse(bootstrapMatch?.[1] ?? '{}') as {
		appBackend?: { basePath?: string; facetNames?: Array<string> }
	}
	expect(bootstrap.appBackend).toEqual({
		basePath: '/app/app-456',
		facetNames: ['main'],
	})
})

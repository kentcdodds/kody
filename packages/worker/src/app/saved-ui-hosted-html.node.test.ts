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

test('renderHostedSavedUiHtml emits shared runtime assets for html apps', () => {
	const result = renderHostedSavedUiHtml({
		artifact: {
			id: 'app-123',
			user_id: 'user-123',
			title: 'Hosted App',
			description: 'Hosted generated UI app',
			keywords: 'hosted,generated-ui',
			code: '<main>Hello</main>',
			runtime: 'html',
			parameters: null,
			search_text: null,
			created_at: '2026-03-27T00:00:00.000Z',
			updated_at: '2026-03-27T00:00:00.000Z',
		},
		appSession,
		appBaseUrl: 'https://kody.example',
	})

	expect(result).toContain(
		'<link rel="stylesheet" href="https://kody.example/mcp-apps/generated-ui-runtime.css" />',
	)
	expect(result).toContain(
		'<script type="module" src="https://kody.example/mcp-apps/generated-ui-shell.js"></script>',
	)
	expect(result).toContain(
		'window.__kodyGeneratedUiBootstrap = {"mode":"hosted","appSession":{"token":"token-123","endpoints":{"source":"https://kody.example/ui-api/session-123/source","execute":"https://kody.example/ui-api/session-123/execute","secrets":"https://kody.example/ui-api/session-123/secrets","deleteSecret":"https://kody.example/ui-api/session-123/secrets/delete"}}};',
	)
})

test('renderHostedSavedUiHtml keeps user javascript separate from runtime bootstrap', () => {
	const result = renderHostedSavedUiHtml({
		artifact: {
			id: 'app-456',
			user_id: 'user-123',
			title: 'Hosted JS App',
			description: 'Hosted generated UI javascript app',
			keywords: 'hosted,generated-ui,javascript',
			code: 'document.querySelector("[data-generated-ui-root]")?.append("hello")',
			runtime: 'javascript',
			parameters: null,
			search_text: null,
			created_at: '2026-03-27T00:00:00.000Z',
			updated_at: '2026-03-27T00:00:00.000Z',
		},
		appSession,
		appBaseUrl: 'https://kody.example',
	})

	expect(result).toContain(
		'<script type="module" src="https://kody.example/mcp-apps/generated-ui-shell.js"></script>',
	)
	expect(result).toContain(
		'<script type="module">\ndocument.querySelector("[data-generated-ui-root]")?.append("hello")',
	)
	expect(result).not.toContain('const appSession =')
})

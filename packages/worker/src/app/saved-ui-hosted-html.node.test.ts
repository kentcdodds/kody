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
			code: '<main>Hello</main>',
			runtime: 'html',
			parameters: null,
			created_at: '2026-03-27T00:00:00.000Z',
			updated_at: '2026-03-27T00:00:00.000Z',
		},
		appSession,
		appBaseUrl: 'https://kody.example',
	})

	const stylesheetMatch = result.match(
		/<link rel="stylesheet" href="([^"]+kody-ui-utils\.css)" \/>/,
	)
	expect(stylesheetMatch?.[1]).toBe(
		'https://kody.example/mcp-apps/kody-ui-utils.css',
	)
	const runtimeScriptMatch = result.match(
		/<script type="module" src="([^"]+kody-ui-utils\.js)"><\/script>/,
	)
	expect(runtimeScriptMatch?.[1]).toBe(
		'https://kody.example/mcp-apps/kody-ui-utils.js',
	)
	const importMapMatch = result.match(
		/<script type="importmap">([^<]+)<\/script>/,
	)
	expect(importMapMatch).not.toBeNull()
	const importMap = JSON.parse(importMapMatch?.[1] ?? '{}') as {
		imports?: Record<string, string>
	}
	expect(importMap.imports?.['@kody/ui-utils']).toBe(
		'https://kody.example/mcp-apps/kody-ui-utils.js',
	)
	const bootstrapMatch = result.match(
		/window\.__kodyGeneratedUiBootstrap = ([^;]+);/,
	)
	expect(bootstrapMatch).not.toBeNull()
	const bootstrap = JSON.parse(bootstrapMatch?.[1] ?? '{}') as {
		mode?: string
		appSession?: { token?: string; endpoints?: Record<string, string> }
	}
	expect(bootstrap.mode).toBe('hosted')
	expect(bootstrap.appSession?.token).toBe('token-123')
	expect(bootstrap.appSession?.endpoints).toEqual({
		source: 'https://kody.example/ui-api/session-123/source',
		execute: 'https://kody.example/ui-api/session-123/execute',
		secrets: 'https://kody.example/ui-api/session-123/secrets',
		deleteSecret: 'https://kody.example/ui-api/session-123/secrets/delete',
	})
})

test('renderHostedSavedUiHtml keeps user javascript separate from runtime bootstrap', () => {
	const result = renderHostedSavedUiHtml({
		artifact: {
			id: 'app-456',
			user_id: 'user-123',
			title: 'Hosted JS App',
			description: 'Hosted generated UI javascript app',
			code: 'document.querySelector("[data-generated-ui-root]")?.append("hello")',
			runtime: 'javascript',
			parameters: null,
			created_at: '2026-03-27T00:00:00.000Z',
			updated_at: '2026-03-27T00:00:00.000Z',
		},
		appSession,
		appBaseUrl: 'https://kody.example',
	})

	const importMapMatch = result.match(
		/<script type="importmap">([^<]+)<\/script>/,
	)
	expect(importMapMatch).not.toBeNull()
	const importMap = JSON.parse(importMapMatch?.[1] ?? '{}') as {
		imports?: Record<string, string>
	}
	expect(importMap.imports?.['@kody/ui-utils']).toBe(
		'https://kody.example/mcp-apps/kody-ui-utils.js',
	)
	expect(result).toContain(
		'<script type="module">\n' +
			'document.querySelector("[data-generated-ui-root]")?.append("hello")',
	)
	const bootstrapMatch = result.match(
		/window\.__kodyGeneratedUiBootstrap = ([^;]+);/,
	)
	expect(bootstrapMatch).not.toBeNull()
	const bootstrap = JSON.parse(bootstrapMatch?.[1] ?? '{}') as {
		appSession?: { token?: string }
	}
	expect(bootstrap.appSession?.token).toBe('token-123')
})

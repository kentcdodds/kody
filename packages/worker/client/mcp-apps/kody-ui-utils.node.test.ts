import { createContext, Script } from 'node:vm'
import { expect, test, vi } from 'vitest'
import * as uiUtils from './kody-ui-utils.ts'
import {
	getKodyWidgetRuntimeStateForTest,
	updateGeneratedUiRuntimeBootstrap,
} from './kody-widget-runtime.ts'

const {
	absolutizeHtmlAttributeUrls,
	buildCodemodeCapabilityExecuteCode,
	buildGeneratedUiRuntimeHeadInjection,
	injectIntoHtmlDocument,
	injectRuntimeStateIntoDocument,
	kodyWidget,
	measureRenderedFrameSize,
	readSavedPackageAppSourceFromHostToolResult,
	shouldInitializeGeneratedUiRuntimeImmediately,
} = uiUtils

function installWindowLocation(href: string) {
	const currentWindow = globalThis.window as Window | undefined
	const location = new URL(href)
	globalThis.window = {
		...(currentWindow ?? {}),
		location,
	} as Window & typeof globalThis
	globalThis.location = location as Location
}

function executeInlineWindowScript(html: string, scriptPattern: RegExp) {
	const scriptMatch = html.match(scriptPattern)
	expect(scriptMatch?.[1]).toBeDefined()
	const window = {} as Record<string, unknown>
	const context = createContext({ window })
	new Script(scriptMatch?.[1] ?? '').runInContext(context)
	return window
}

test('document helpers preserve structure while rewriting only supported urls', () => {
	const injectedIntoExistingHead = injectIntoHtmlDocument(
		'<!doctype html><html lang="en" class="demo"><head data-shell="true"><title>Demo</title></head><body></body></html>',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)
	expect(injectedIntoExistingHead).toMatch(
		/<html\b[^>]*lang="en"[^>]*class="demo"[^>]*>/,
	)
	expect(injectedIntoExistingHead).toMatch(
		/<head\b[^>]*data-shell="true"[^>]*>/,
	)
	expect(injectedIntoExistingHead).toContain('<title>Demo</title>')
	expect(injectedIntoExistingHead).toContain(
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)

	const injectedWithoutHead = injectIntoHtmlDocument(
		'<html lang="en" class="demo" data-app="shell"><body><main>Hello</main></body></html>',
		'<style>body { color: red; }</style>',
	)
	expect(injectedWithoutHead).toMatch(
		/<html\b[^>]*lang="en"[^>]*class="demo"[^>]*data-app="shell"[^>]*>/,
	)
	expect(injectedWithoutHead).toMatch(
		/<head><style>body \{ color: red; \}<\/style><\/head>/,
	)
	expect(injectedWithoutHead).toContain('<body><main>Hello</main></body>')

	const absolutized = absolutizeHtmlAttributeUrls(
		[
			'<html><head><link rel="stylesheet" href="/styles.css" /></head><body>',
			'<img src="/logo.png" />',
			'<a href="/chat">Chat</a>',
			'<form action="/logout"><button>Logout</button></form>',
			'<img srcset="/logo.png 1x, /logo@2x.png 2x" />',
			'<a href="#section">Jump</a>',
			'<img src="data:image/png;base64,abc" />',
			'<a href="javascript:alert(1)">Run</a>',
			'</body></html>',
		].join(''),
		'https://kody-production.kentcdodds.workers.dev/',
	)

	expect(absolutized).toContain(
		'href="https://kody-production.kentcdodds.workers.dev/styles.css"',
	)
	expect(absolutized).toContain(
		'src="https://kody-production.kentcdodds.workers.dev/logo.png"',
	)
	expect(absolutized).toContain(
		'href="https://kody-production.kentcdodds.workers.dev/chat"',
	)
	expect(absolutized).toContain(
		'action="https://kody-production.kentcdodds.workers.dev/logout"',
	)
	expect(absolutized).toContain(
		'srcset="https://kody-production.kentcdodds.workers.dev/logo.png 1x, https://kody-production.kentcdodds.workers.dev/logo@2x.png 2x"',
	)
	expect(absolutized).toContain('href="#section"')
	expect(absolutized).toContain('src="data:image/png;base64,abc"')
	expect(absolutized).toContain('href="javascript:alert(1)"')

	expect(
		measureRenderedFrameSize({
			documentElement: {
				scrollHeight: 420,
				scrollWidth: 610,
				offsetHeight: 410,
				offsetWidth: 600,
				getBoundingClientRect: () => ({ height: 405.2, width: 598.6 }),
			},
			body: {
				scrollHeight: 530,
				scrollWidth: 580,
				offsetHeight: 520,
				offsetWidth: 570,
				getBoundingClientRect: () => ({ height: 518.4, width: 640.2 }),
			},
		}),
	).toEqual({
		height: 530,
		width: 641,
	})
})

test('injectRuntimeStateIntoDocument exposes runtime bootstrap globals', () => {
	const result = injectRuntimeStateIntoDocument('<main>Hello</main>', {
		owner: 'kody',
		limit: 3,
	})
	expect(result).toContain('<main>Hello</main>')
	const windowState = executeInlineWindowScript(
		result,
		/<script>\s*([\s\S]*?)\s*<\/script>/,
	)
	expect(windowState.__kodyGeneratedUiBootstrap).toEqual({
		mode: 'mcp',
		params: {
			owner: 'kody',
			limit: 3,
		},
	})
	expect(windowState.__kodyAppParams).toEqual({
		owner: 'kody',
		limit: 3,
	})
	expect(windowState.params).toEqual({
		owner: 'kody',
		limit: 3,
	})
})

test('readSavedPackageAppSourceFromHostToolResult handles success and host tool errors', () => {
	expect(
		readSavedPackageAppSourceFromHostToolResult({
			structuredContent: {
				app_id: 'app-123',
				client_code: '<main>hello</main>',
			},
		}),
	).toEqual({
		handled: true,
		runtime: 'html',
		code: '<main>hello</main>',
	})
	expect(
		readSavedPackageAppSourceFromHostToolResult({
			isError: true,
			structuredContent: {
				error: {
					message: 'Saved package app not found for this user.',
				},
			},
		}),
	).toEqual({
		handled: true,
		errorMessage: 'Saved package app not found for this user.',
	})
	const secretMissing = readSavedPackageAppSourceFromHostToolResult({
		isError: true,
		structuredContent: {
			error: 'Secret "cloudflareToken" was not found.',
			errorDetails: {
				nextStep:
					'Send the user to /account/secrets/new?name=cloudflareToken so they can provide and save this secret, then retry the workflow.',
			},
		},
	})
	expect(secretMissing).toMatchObject({
		handled: true,
		errorMessage: expect.any(String),
	})
})

test('buildCodemodeCapabilityExecuteCode runs the intended capability with the original args', async () => {
	const code = buildCodemodeCapabilityExecuteCode('value_set', {
		name: 'workspaceSlug',
		value: 'kody',
		scope: 'app',
	})
	const calls: Array<{ capability: string; args: unknown }> = []
	const context = createContext({
		codemode: {
			async value_set(args: unknown) {
				calls.push({
					capability: 'value_set',
					args: JSON.parse(JSON.stringify(args)),
				})
				return 'ok'
			},
		},
	})

	await expect(new Script(`(${code})()`).runInContext(context)).resolves.toBe(
		'ok',
	)
	expect(calls).toEqual([
		{
			capability: 'value_set',
			args: {
				name: 'workspaceSlug',
				value: 'kody',
				scope: 'app',
			},
		},
	])
})

test('kodyWidget runtime installs helpers, refreshes bootstrap state, and routes hosted app backend requests', async () => {
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()

	expect(kodyWidget.params).toEqual({})
	expect(kodyWidget.appBackend).toBeNull()

	runtimeState.install({
		mode: 'mcp',
		params: { owner: 'kody' },
		hooks: {
			executeCode: async () => 'ok',
		},
		appSession: {
			token: 'token-1',
			endpoints: {
				source: 'https://kody.example/ui-api/app/source',
				execute: 'https://kody.example/ui-api/app/execute',
				secrets: 'https://kody.example/ui-api/app/secrets',
				deleteSecret: 'https://kody.example/ui-api/app/secrets/delete',
			},
		},
	})

	expect(kodyWidget.params).toEqual({ owner: 'kody' })
	await expect(kodyWidget.executeCode('return "ok"')).resolves.toBe('ok')

	updateGeneratedUiRuntimeBootstrap({
		mode: 'mcp',
		params: { owner: 'updated', limit: 3 },
		appSession: {
			token: 'token-2',
			endpoints: {
				source: 'https://kody.example/ui-api/next/source',
				execute: 'https://kody.example/ui-api/next/execute',
				secrets: 'https://kody.example/ui-api/next/secrets',
				deleteSecret: 'https://kody.example/ui-api/next/secrets/delete',
			},
		},
	})
	expect(kodyWidget.params).toEqual({ owner: 'updated', limit: 3 })

	installWindowLocation('http://localhost:3000/ui/app-123')
	runtimeState.reset()
	runtimeState.install({
		mode: 'hosted',
		appSession: {
			token: 'app-session-token',
			endpoints: {
				source: 'https://kody.example/ui-api/app-123/source',
				execute: 'https://kody.example/ui-api/app-123/execute',
				secrets: 'https://kody.example/ui-api/app-123/secrets',
				deleteSecret: 'https://kody.example/ui-api/app-123/secrets/delete',
			},
		},
		appBackend: {
			basePath: '/app/app-123',
			facetNames: ['main'],
		},
	})

	expect(kodyWidget.appBackend?.resolveUrl()).toBe(
		'http://localhost:3000/app/app-123',
	)
	expect(kodyWidget.appBackend?.resolveUrl('api/state')).toBe(
		'http://localhost:3000/app/app-123/api/state',
	)
	expect(kodyWidget.appBackend?.resolveUrl('/api/state')).toBe(
		'http://localhost:3000/app/app-123/api/state',
	)
	expect(kodyWidget.appBackend?.resolveUrl('?view=full')).toBe(
		'http://localhost:3000/app/app-123?view=full',
	)
	expect(
		kodyWidget.appBackend?.resolveUrl(
			new URL('http://localhost:3000/app/app-123/api/state'),
		),
	).toBe('http://localhost:3000/app/app-123/api/state')
	expect(() =>
		kodyWidget.appBackend?.resolveUrl('http://localhost:3000/ui/app-123'),
	).toThrow(/only supports same-origin urls within the app backend base path/i)
	expect(() =>
		kodyWidget.appBackend?.resolveUrl(
			'https://example.com/app/app-123/api/state',
		),
	).toThrow(/only supports same-origin urls within the app backend base path/i)

	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(JSON.stringify({ ok: true })))

	try {
		await kodyWidget.appBackend?.fetch('api/state', {
			method: 'POST',
			body: JSON.stringify({ action: 'refresh' }),
		})

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [requestUrl, requestInit] = fetchSpy.mock.calls[0] ?? []
		expect(requestUrl).toBe('http://localhost:3000/app/app-123/api/state')
		expect((requestInit as RequestInit | undefined)?.method).toBe('POST')
		expect((requestInit as RequestInit | undefined)?.credentials).toBe('omit')
		const headers = new Headers(
			(requestInit as RequestInit | undefined)?.headers,
		)
		expect(headers.get('Authorization')).toBe('Bearer app-session-token')

		await kodyWidget.appBackend?.fetch('api/state', {
			headers: {
				Authorization: 'Bearer explicit-token',
			},
		})

		const [, explicitRequestInit] = fetchSpy.mock.calls[1] ?? []
		const explicitHeaders = new Headers(
			(explicitRequestInit as RequestInit | undefined)?.headers,
		)
		expect(explicitHeaders.get('Authorization')).toBe('Bearer explicit-token')
		expect(fetchSpy).toHaveBeenCalledTimes(2)
	} finally {
		fetchSpy.mockRestore()
	}
})

test('generated UI runtime head injection bootstraps state, defers entry init until ready, and only includes the module script when needed', () => {
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'loading',
			bootstrapMode: 'entry',
		}),
	).toBe(false)
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'complete',
			bootstrapMode: 'entry',
		}),
	).toBe(true)

	const defaultHead = buildGeneratedUiRuntimeHeadInjection({
		mode: 'mcp',
		params: {},
		baseHref: 'https://kody.example/',
	})
	expect(defaultHead).toContain('type="importmap"')
	const defaultWindowState = executeInlineWindowScript(
		defaultHead,
		/<script>\s*(window\.__kodyGeneratedUiBootstrap =[\s\S]*?)\s*<\/script>/,
	)
	expect(defaultWindowState.__kodyGeneratedUiBootstrap).toEqual({
		mode: 'mcp',
		params: {},
	})
	const defaultModuleScript = defaultHead.match(
		/<script type="module" src="([^"]+)"><\/script>/,
	)
	expect(defaultModuleScript?.[1]).toMatch(/kody-ui-utils\.js$/)

	const shellRenderedHead = buildGeneratedUiRuntimeHeadInjection({
		mode: 'mcp',
		params: {},
		baseHref: 'https://kody.example/',
		includeRuntimeScript: false,
	})
	expect(shellRenderedHead).toContain('type="importmap"')
	const shellWindowState = executeInlineWindowScript(
		shellRenderedHead,
		/<script>\s*(window\.__kodyGeneratedUiBootstrap =[\s\S]*?)\s*<\/script>/,
	)
	expect(shellWindowState.__kodyGeneratedUiBootstrap).toEqual({
		mode: 'mcp',
		params: {},
	})
	expect(shellRenderedHead).not.toMatch(/<script type="module"/)
})

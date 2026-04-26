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

test('document helpers preserve structure while rewriting only supported urls', () => {
	const injectedIntoExistingHead = injectIntoHtmlDocument(
		'<!doctype html><html lang="en" class="demo"><head data-shell="true"><title>Demo</title></head><body></body></html>',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)
	expect(injectedIntoExistingHead).toContain('<html lang="en" class="demo">')
	expect(injectedIntoExistingHead).toContain('<title>Demo</title>')
	expect(injectedIntoExistingHead).toContain(
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)

	const injectedWithoutHead = injectIntoHtmlDocument(
		'<html lang="en" class="demo" data-app="shell"><body><main>Hello</main></body></html>',
		'<style>body { color: red; }</style>',
	)
	expect(injectedWithoutHead).toContain(
		'<html lang="en" class="demo" data-app="shell">',
	)
	expect(injectedWithoutHead).toContain(
		'<head><style>body { color: red; }</style></head>',
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
})

test('measureRenderedFrameSize uses the largest body and document dimensions', () => {
	const size = measureRenderedFrameSize({
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
	})

	expect(size).toEqual({
		height: 530,
		width: 641,
	})
})

test('injectRuntimeStateIntoDocument exposes runtime bootstrap globals', () => {
	const result = injectRuntimeStateIntoDocument('<main>Hello</main>', {
		owner: 'kody',
		limit: 3,
	})
	const bootstrapMatch = result.match(
		/window\.__kodyGeneratedUiBootstrap = (.+);/,
	)
	expect(bootstrapMatch?.[1]).toBeDefined()
	expect(JSON.parse(bootstrapMatch?.[1] ?? 'null')).toEqual({
		mode: 'mcp',
		params: {
			owner: 'kody',
			limit: 3,
		},
	})
	expect(result).toContain('window.__kodyAppParams =')
	expect(result).toContain('window.params =')
})

test('readSavedPackageAppSourceFromHostToolResult reads a package app source payload', () => {
	const result = readSavedPackageAppSourceFromHostToolResult({
		structuredContent: {
			app_id: 'app-123',
			client_code: '<main>hello</main>',
		},
	})

	expect(result).toEqual({
		handled: true,
		runtime: 'html',
		code: '<main>hello</main>',
	})
})

test('readSavedPackageAppSourceFromHostToolResult preserves host tool errors', () => {
	const result = readSavedPackageAppSourceFromHostToolResult({
		isError: true,
		structuredContent: {
			error: {
				message: 'Saved package app not found for this user.',
			},
		},
	})

	expect(result).toEqual({
		handled: true,
		errorMessage: 'Saved package app not found for this user.',
	})
})

test('buildCodemodeCapabilityExecuteCode serializes capability calls safely', () => {
	const code = buildCodemodeCapabilityExecuteCode('value_set', {
		name: 'workspaceSlug',
		value: 'kody',
		scope: 'app',
	})

	const [opener, invocation, closer] = code.split('\n')
	expect(opener).toBe('async () => {')
	expect(closer).toBe('}')
	expect(invocation).toBe(
		'  return await codemode["value_set"]({"name":"workspaceSlug","value":"kody","scope":"app"});',
	)
})

test('kodyWidget public api exposes executeCode helper', () => {
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	expect(typeof kodyWidget.executeCode).toBe('function')
})

test('kodyWidget public api exposes appBackend helper facade when available', () => {
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	runtimeState.install({
		mode: 'hosted',
		appBackend: {
			basePath: '/app/app-123',
			facetNames: ['main'],
		},
	})

	expect(kodyWidget.appBackend).not.toBeNull()
	expect(kodyWidget.appBackend?.basePath).toBe('/app/app-123')
	expect(kodyWidget.appBackend?.facetNames).toEqual(['main'])
	expect(typeof kodyWidget.appBackend?.resolveUrl).toBe('function')
	expect(typeof kodyWidget.appBackend?.fetch).toBe('function')
})

test('public module does not export readiness helpers', () => {
	expect('getKodyWidget' in uiUtils).toBe(false)
	expect('whenKodyWidgetReady' in uiUtils).toBe(false)
})

test('imported kodyWidget is synchronously stable before runtime init', () => {
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	const kodyGlobal = globalThis as typeof globalThis & {
		kodyWidget?: typeof kodyWidget
	}

	expect(kodyWidget).toBe(kodyGlobal.kodyWidget)
	expect(kodyWidget.params).toEqual({})
	expect(typeof kodyWidget.sendMessage).toBe('function')
})

test('async helpers read installed runtime state', async () => {
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	runtimeState.install({
		mode: 'mcp',
		params: { owner: 'kody' },
		hooks: {
			executeCode: async () => 'ok',
		},
	})

	expect(kodyWidget.params).toEqual({ owner: 'kody' })
	await expect(kodyWidget.executeCode('return "ok"')).resolves.toBe('ok')
})

test('runtime bootstrap updates refresh params and app session without reinit', () => {
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	runtimeState.install({
		mode: 'mcp',
		params: { owner: 'kody' },
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
})

test('appBackend.resolveUrl resolves backend-relative paths safely', () => {
	installWindowLocation('http://localhost:3000/ui/app-123')
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	runtimeState.install({
		mode: 'hosted',
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
})

test('appBackend.resolveUrl rejects urls outside the package app backend path', () => {
	installWindowLocation('http://localhost:3000/ui/app-123')
	const runtimeState = getKodyWidgetRuntimeStateForTest()
	runtimeState.reset()
	runtimeState.install({
		mode: 'hosted',
		appBackend: {
			basePath: '/app/app-123',
			facetNames: ['main'],
		},
	})

	expect(() =>
		kodyWidget.appBackend?.resolveUrl('http://localhost:3000/ui/app-123'),
	).toThrow(/only supports same-origin urls within the app backend base path/i)
	expect(() =>
		kodyWidget.appBackend?.resolveUrl(
			'https://example.com/app/app-123/api/state',
		),
	).toThrow(/only supports same-origin urls within the app backend base path/i)
})

test('appBackend.fetch adds the generated ui bearer token by default', async () => {
	installWindowLocation('http://localhost:3000/ui/app-123')
	const runtimeState = getKodyWidgetRuntimeStateForTest()
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
	} finally {
		fetchSpy.mockRestore()
	}
})

test('appBackend.fetch preserves explicit authorization headers', async () => {
	installWindowLocation('http://localhost:3000/ui/app-123')
	const runtimeState = getKodyWidgetRuntimeStateForTest()
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

	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(JSON.stringify({ ok: true })))

	try {
		await kodyWidget.appBackend?.fetch('api/state', {
			headers: {
				Authorization: 'Bearer explicit-token',
			},
		})

		const [, requestInit] = fetchSpy.mock.calls[0] ?? []
		const headers = new Headers(
			(requestInit as RequestInit | undefined)?.headers,
		)
		expect(headers.get('Authorization')).toBe('Bearer explicit-token')
	} finally {
		fetchSpy.mockRestore()
	}
})

test('runtime-backed helpers time out if the runtime never becomes ready', async () => {
	vi.useFakeTimers()
	try {
		const runtimeState = getKodyWidgetRuntimeStateForTest()
		runtimeState.reset()
		runtimeState.install({
			mode: 'mcp',
			ready: false,
		})

		const pending = kodyWidget.executeCode('return "ok"')
		const rejection = expect(pending).rejects.toThrow(
			/timed out waiting for the kodyWidget runtime to initialize/i,
		)

		await vi.advanceTimersByTimeAsync(10_001)
		await rejection
	} finally {
		vi.useRealTimers()
	}
})

test('buildGeneratedUiRuntimeHeadInjection always bootstraps runtime state and only includes the module script when needed', () => {
	const defaultHead = buildGeneratedUiRuntimeHeadInjection({
		mode: 'mcp',
		params: {},
		baseHref: 'https://kody.example/',
	})
	expect(defaultHead).toContain('type="importmap"')
	expect(defaultHead).toContain('window.__kodyGeneratedUiBootstrap')
	expect(defaultHead).toMatch(
		/<script type="module" src="[^"]*kody-ui-utils\.js"/,
	)

	const shellRenderedHead = buildGeneratedUiRuntimeHeadInjection({
		mode: 'mcp',
		params: {},
		baseHref: 'https://kody.example/',
		includeRuntimeScript: false,
	})
	expect(shellRenderedHead).toContain('type="importmap"')
	expect(shellRenderedHead).toContain('window.__kodyGeneratedUiBootstrap')
	expect(shellRenderedHead).not.toMatch(/<script type="module"/)
})

test('hosted and mcp runtimes initialize immediately on import', () => {
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'loading',
			bootstrapMode: 'hosted',
		}),
	).toBe(true)
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'loading',
			bootstrapMode: 'mcp',
		}),
	).toBe(true)
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'loading',
			bootstrapMode: 'entry',
		}),
	).toBe(false)
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'interactive',
			bootstrapMode: 'entry',
		}),
	).toBe(true)
	expect(
		shouldInitializeGeneratedUiRuntimeImmediately({
			documentReadyState: 'complete',
			bootstrapMode: 'entry',
		}),
	).toBe(true)
})

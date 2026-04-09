import { expect, test, vi } from 'vitest'
import * as uiUtils from './kody-ui-utils.ts'
import { getKodyWidgetRuntimeStateForTest } from './kody-widget-runtime.ts'

const {
	absolutizeHtmlAttributeUrls,
	buildCodemodeCapabilityExecuteCode,
	buildGeneratedUiRuntimeHeadInjection,
	injectIntoHtmlDocument,
	injectRuntimeStateIntoDocument,
	kodyWidget,
	measureRenderedFrameSize,
	readSavedAppSourceFromHostToolResult,
	shouldInitializeGeneratedUiRuntimeImmediately,
} = uiUtils

test('injectIntoHtmlDocument inserts content into an existing head', () => {
	const result = injectIntoHtmlDocument(
		'<!doctype html><html lang="en" class="demo"><head data-shell="true"><title>Demo</title></head><body></body></html>',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)

	expect(result).toContain('<html lang="en" class="demo">')
	expect(result).toContain(
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)
	expect(result).toContain('<title>Demo</title>')
})

test('injectIntoHtmlDocument preserves html attributes when injecting a missing head', () => {
	const result = injectIntoHtmlDocument(
		'<html lang="en" class="demo" data-app="shell"><body><main>Hello</main></body></html>',
		'<style>body { color: red; }</style>',
	)

	expect(result).toContain(
		'<html lang="en" class="demo" data-app="shell"><head><style>body { color: red; }</style></head><body><main>Hello</main></body></html>',
	)
})

test('injectIntoHtmlDocument preserves existing html attributes untouched', () => {
	const result = injectIntoHtmlDocument(
		'<html lang="en" data-kody-theme="dark"><body></body></html>',
		'<style>body { color: red; }</style>',
	)

	expect(result).toContain(
		'<html lang="en" data-kody-theme="dark"><head><style>body { color: red; }</style></head><body></body></html>',
	)
})

test('absolutizeHtmlAttributeUrls resolves worker-relative urls', () => {
	const result = absolutizeHtmlAttributeUrls(
		[
			'<html><head><link rel="stylesheet" href="/styles.css" /></head><body>',
			'<img src="/logo.png" />',
			'<a href="/chat">Chat</a>',
			'<form action="/logout"><button>Logout</button></form>',
			'<img srcset="/logo.png 1x, /logo@2x.png 2x" />',
			'</body></html>',
		].join(''),
		'https://kody-production.kentcdodds.workers.dev/',
	)

	expect(result).toContain(
		'href="https://kody-production.kentcdodds.workers.dev/styles.css"',
	)
	expect(result).toContain(
		'src="https://kody-production.kentcdodds.workers.dev/logo.png"',
	)
	expect(result).toContain(
		'href="https://kody-production.kentcdodds.workers.dev/chat"',
	)
	expect(result).toContain(
		'action="https://kody-production.kentcdodds.workers.dev/logout"',
	)
	expect(result).toContain(
		'srcset="https://kody-production.kentcdodds.workers.dev/logo.png 1x, https://kody-production.kentcdodds.workers.dev/logo@2x.png 2x"',
	)
})

test('absolutizeHtmlAttributeUrls leaves hash, data, and javascript urls untouched', () => {
	const result = absolutizeHtmlAttributeUrls(
		[
			'<html><body>',
			'<a href="#section">Jump</a>',
			'<img src="data:image/png;base64,abc" />',
			'<a href="javascript:alert(1)">Run</a>',
			'</body></html>',
		].join(''),
		'https://kody-production.kentcdodds.workers.dev/',
	)

	expect(result).toContain('href="#section"')
	expect(result).toContain('src="data:image/png;base64,abc"')
	expect(result).toContain('href="javascript:alert(1)"')
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
	expect(result).toContain(
		'window.__kodyGeneratedUiBootstrap = {"mode":"mcp","params":{"owner":"kody","limit":3}};',
	)
	expect(result).toContain(
		'window.__kodyAppParams = window.__kodyGeneratedUiBootstrap.params ?? {};',
	)
	expect(result).toContain('window.params = window.__kodyAppParams;')
})

test('readSavedAppSourceFromHostToolResult reads a saved app source payload', () => {
	const result = readSavedAppSourceFromHostToolResult({
		structuredContent: {
			app_id: 'app-123',
			runtime: 'javascript',
			code: 'console.log("hello")',
		},
	})

	expect(result).toEqual({
		handled: true,
		runtime: 'javascript',
		code: 'console.log("hello")',
	})
})

test('readSavedAppSourceFromHostToolResult preserves host tool errors', () => {
	const result = readSavedAppSourceFromHostToolResult({
		isError: true,
		structuredContent: {
			error: {
				message: 'Saved app not found for this user.',
			},
		},
	})

	expect(result).toEqual({
		handled: true,
		errorMessage: 'Saved app not found for this user.',
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

test('buildGeneratedUiRuntimeHeadInjection includes module script by default', () => {
	const head = buildGeneratedUiRuntimeHeadInjection({
		mode: 'mcp',
		params: {},
		baseHref: 'https://kody.example/',
	})
	expect(head).toContain('type="importmap"')
	expect(head).toMatch(/<script type="module" src="[^"]*kody-ui-utils\.js"/)
})

test('buildGeneratedUiRuntimeHeadInjection can omit module script for shell-rendered apps', () => {
	const head = buildGeneratedUiRuntimeHeadInjection({
		mode: 'mcp',
		params: {},
		baseHref: 'https://kody.example/',
		includeRuntimeScript: false,
	})
	expect(head).toContain('type="importmap"')
	expect(head).toContain('window.__kodyGeneratedUiBootstrap')
	expect(head).not.toMatch(/<script type="module"/)
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

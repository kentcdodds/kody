import { expect, test } from 'vitest'
import {
	absolutizeHtmlAttributeUrls,
	buildCodemodeCapabilityExecuteCode,
	getOrCreateKodyWidgetReadyStateForTest,
	getKodyWidget,
	injectIntoHtmlDocument,
	injectRuntimeStateIntoDocument,
	kodyWidget,
	measureRenderedFrameSize,
	readSavedAppSourceFromHostToolResult,
	shouldInitializeGeneratedUiRuntimeImmediately,
	whenKodyWidgetReady,
} from './kody-ui-utils.ts'

test('injectIntoHtmlDocument inserts into an existing head without adding an extra bracket', () => {
	const result = injectIntoHtmlDocument(
		'<!doctype html><html lang="en" class="demo"><head data-shell="true"><title>Demo</title></head><body></body></html>',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
	)

	expect(result).toContain('<html lang="en" class="demo">')
	expect(result).toContain(
		'<head data-shell="true">\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Demo</title>',
	)
	expect(result).not.toContain('<head>>')
	expect(result).not.toContain('<head data-shell="true">>')
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

test('absolutizeHtmlAttributeUrls resolves worker-relative urls without adding a base tag', () => {
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
	expect(result).not.toContain('<base ')
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

	expect(code).toContain('async () => {')
	expect(code).toContain('codemode["value_set"]')
	expect(code).toContain('"name":"workspaceSlug"')
	expect(code).toContain('"scope":"app"')
})

test('getKodyWidget throws until the runtime is ready', () => {
	const readyState = getOrCreateKodyWidgetReadyStateForTest()
	readyState.reset()

	expect(() => getKodyWidget()).toThrow(
		/kodyWidget is not ready yet.*whenKodyWidgetReady/,
	)
})

test('whenKodyWidgetReady resolves once the runtime publishes the widget', async () => {
	const readyState = getOrCreateKodyWidgetReadyStateForTest()
	readyState.reset()

	const fakeWidget = {
		params: { owner: 'kody' },
		sendMessage() {
			return true
		},
	}

	const pendingWidget = whenKodyWidgetReady()
	readyState.resolve(fakeWidget)

	await expect(pendingWidget).resolves.toBe(fakeWidget)
	await expect(whenKodyWidgetReady()).resolves.toBe(fakeWidget)
})

test('imported kodyWidget proxy exposes resolved runtime properties', () => {
	const readyState = getOrCreateKodyWidgetReadyStateForTest()
	readyState.reset()
	const fakeWidget = {
		params: {},
		value: 41,
	} as {
		params: Record<string, never>
		value: number
	}
	readyState.resolve(fakeWidget)

	expect(kodyWidget.value).toBe(41)
	expect(kodyWidget.params).toEqual({})
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

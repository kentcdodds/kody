import { expect, test } from 'vitest'
import {
	absolutizeHtmlAttributeUrls,
	buildCodemodeCapabilityExecuteCode,
	buildLocalMessageLogRuntimeSource,
	injectIntoHtmlDocument,
	injectRuntimeStateIntoDocument,
	measureRenderedFrameSize,
	readSavedAppSourceFromHostToolResult,
} from './generated-ui-shell.ts'

class FakeElement {
	tagName: string
	style = { cssText: '' }
	attributes = new Map<string, string>()
	childNodes: Array<FakeElement> = []
	parentNode: FakeElement | null = null
	textContent = ''
	scrollTop = 0
	scrollHeight = 0

	constructor(tagName: string) {
		this.tagName = tagName
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value)
	}

	appendChild(child: FakeElement) {
		child.parentNode = this
		this.childNodes.push(child)
		this.scrollHeight = this.childNodes.length * 100
		return child
	}

	removeChild(child: FakeElement) {
		const index = this.childNodes.indexOf(child)
		if (index >= 0) {
			this.childNodes.splice(index, 1)
			child.parentNode = null
			this.scrollHeight = this.childNodes.length * 100
		}
		return child
	}

	get firstChild() {
		return this.childNodes[0] ?? null
	}
}

class FakeDocument {
	body = new FakeElement('body')
	documentElement = new FakeElement('html')

	createElement(tagName: string) {
		return new FakeElement(tagName)
	}
}

test('injectIntoHtmlDocument inserts into an existing head without adding an extra bracket', () => {
	const result = injectIntoHtmlDocument(
		'<!doctype html><html lang="en" class="demo"><head data-shell="true"><title>Demo</title></head><body></body></html>',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		'dark',
	)

	expect(result).toContain(
		'<html lang="en" class="demo" data-kody-theme="dark">',
	)
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
		'light',
	)

	expect(result).toContain(
		'<html lang="en" class="demo" data-app="shell" data-kody-theme="light"><head><style>body { color: red; }</style></head><body><main>Hello</main></body></html>',
	)
})

test('injectIntoHtmlDocument does not duplicate an existing theme attribute', () => {
	const result = injectIntoHtmlDocument(
		'<html lang="en" data-kody-theme="dark"><body></body></html>',
		'<style>body { color: red; }</style>',
		'light',
	)

	expect(result).toContain(
		'<html lang="en" data-kody-theme="dark"><head><style>body { color: red; }</style></head><body></body></html>',
	)
	expect(result).not.toContain('data-kody-theme="light"')
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

test('injectRuntimeStateIntoDocument exposes params on window.kodyWidget', () => {
	const result = injectRuntimeStateIntoDocument('<main>Hello</main>', {
		owner: 'kody',
		limit: 3,
	})
	expect(result).toContain('window.kodyWidget = window.kodyWidget ?? {}')
	expect(result).toContain(
		'window.kodyWidget.params = {"owner":"kody","limit":3};',
	)
	expect(result).toContain('window.params = window.kodyWidget.params;')
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

test('buildLocalMessageLogRuntimeSource logs sendMessage locally outside hosted contexts', () => {
	const originalWindow = globalThis.window
	const originalDocument = globalThis.document
	const fakeDocument = new FakeDocument()
	const fakeWindow = {
		parent: null as unknown,
		document: fakeDocument,
		addEventListener() {},
	} as Window & typeof globalThis
	fakeWindow.parent = fakeWindow

	try {
		globalThis.window = fakeWindow
		globalThis.document = fakeDocument as unknown as Document

		new Function(
			[
				buildLocalMessageLogRuntimeSource(),
				'window.kodyWidget = {',
				'	sendMessage(text) {',
				'		if (window.parent === window) {',
				'			return appendLocalMessageLogEntry(text);',
				'		}',
				'		return false;',
				'	},',
				'};',
			].join('\n'),
		)()

		expect(
			globalThis.window.kodyWidget.sendMessage('First mobile message'),
		).toBe(true)
		expect(
			globalThis.window.kodyWidget.sendMessage('Second mobile message'),
		).toBe(true)

		expect(fakeDocument.body.childNodes).toHaveLength(1)
		const logRoot = fakeDocument.body.childNodes[0]
		const logList = logRoot.childNodes[1]
		expect(logRoot.childNodes[0]?.textContent).toBe('Messages')
		expect(logList.childNodes).toHaveLength(2)
		expect(logList.childNodes[0]?.childNodes[1]?.textContent).toBe(
			'First mobile message',
		)
		expect(logList.childNodes[1]?.childNodes[1]?.textContent).toBe(
			'Second mobile message',
		)
	} finally {
		if (originalWindow) {
			globalThis.window = originalWindow
		} else {
			Reflect.deleteProperty(globalThis, 'window')
		}
		if (originalDocument) {
			globalThis.document = originalDocument
		} else {
			Reflect.deleteProperty(globalThis, 'document')
		}
	}
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

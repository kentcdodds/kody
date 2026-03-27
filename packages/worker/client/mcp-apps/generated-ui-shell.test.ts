import { expect, test } from 'vitest'
import {
	absolutizeHtmlAttributeUrls,
	injectIntoHtmlDocument,
	injectRuntimeStateIntoDocument,
	measureRenderedFrameSize,
} from './generated-ui-shell.ts'

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
	const result = injectRuntimeStateIntoDocument(
		'<main>Hello</main>',
		{ owner: 'kody', limit: 3 },
	)
	expect(result).toContain('window.kodyWidget = window.kodyWidget ?? {}')
	expect(result).toContain('window.kodyWidget.params = {"owner":"kody","limit":3};')
	expect(result).toContain('window.params = window.kodyWidget.params;')
})

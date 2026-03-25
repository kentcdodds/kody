import { expect, test } from 'bun:test'
import { injectIntoHtmlDocument } from './generated-ui-shell.ts'

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

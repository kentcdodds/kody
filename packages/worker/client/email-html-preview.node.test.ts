import { expect, test } from 'vitest'
import {
	buildAdminEmailHtmlPreviewDocument,
	stripDangerousEmailHtml,
} from './email-html-preview.ts'

test('stripDangerousEmailHtml removes script blocks', () => {
	const html =
		'<p>Hello</p><script>alert("xss")</script><p>World</p><SCRIPT type="text/javascript">evil()</SCRIPT>'
	expect(stripDangerousEmailHtml(html)).toBe('<p>Hello</p><p>World</p>')
})

test('buildAdminEmailHtmlPreviewDocument wraps HTML fragments', () => {
	const document = buildAdminEmailHtmlPreviewDocument(
		'<p>Invoice <strong>due</strong></p>',
	)
	expect(document).toMatch(/^<!DOCTYPE html>/i)
	expect(document).toContain('<meta name="referrer" content="no-referrer">')
	expect(document).toContain('<p>Invoice <strong>due</strong></p>')
})

test('buildAdminEmailHtmlPreviewDocument preserves full HTML documents', () => {
	const html = `<!DOCTYPE html>
<html>
<head><title>Newsletter</title></head>
<body><h1>Title</h1></body>
</html>`
	const document = buildAdminEmailHtmlPreviewDocument(html)
	expect(document).toContain('<title>Newsletter</title>')
	expect(document).toContain('<meta name="referrer" content="no-referrer">')
	expect(document).not.toMatch(/<html>[\s\S]*<html>/i)
})

test('buildAdminEmailHtmlPreviewDocument strips scripts from full documents', () => {
	const html = `<html><head></head><body><script>bad()</script><p>ok</p></body></html>`
	const document = buildAdminEmailHtmlPreviewDocument(html)
	expect(document).toContain('<p>ok</p>')
	expect(document).not.toMatch(/<script/i)
})

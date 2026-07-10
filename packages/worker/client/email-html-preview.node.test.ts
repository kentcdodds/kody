import { expect, test } from 'vitest'
import {
	buildAdminEmailHtmlPreviewDocument,
	stripDangerousEmailHtml,
} from './email-html-preview.ts'

test('email HTML preview sanitizes scripts and wraps fragments in a safe document', () => {
	const dirty =
		'<p>Hello</p><script>alert("xss")</script><p>World</p><SCRIPT type="text/javascript">evil()</SCRIPT>'
	expect(stripDangerousEmailHtml(dirty)).toBe('<p>Hello</p><p>World</p>')

	const fragment = buildAdminEmailHtmlPreviewDocument(
		'<p>Invoice <strong>due</strong></p>',
	)
	expect(fragment).toMatch(/^<!DOCTYPE html>/i)
	expect(fragment).toContain('content="no-referrer"')
	expect(fragment).toContain('<p>Invoice <strong>due</strong></p>')

	const fullDocument = `<!DOCTYPE html>
<html>
<head><title>Newsletter</title></head>
<body><h1>Title</h1></body>
</html>`
	const preserved = buildAdminEmailHtmlPreviewDocument(fullDocument)
	expect(preserved).toContain('<title>Newsletter</title>')
	expect(preserved).toContain('content="no-referrer"')
	expect(preserved).not.toMatch(/<html>[\s\S]*<html>/i)

	const scripted = `<html><head></head><body><script>bad()</script><p>ok</p></body></html>`
	const sanitized = buildAdminEmailHtmlPreviewDocument(scripted)
	expect(sanitized).toContain('<p>ok</p>')
	expect(sanitized).not.toMatch(/<script/i)
})

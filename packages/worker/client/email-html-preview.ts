const fullHtmlDocumentPattern = /^<!DOCTYPE\s+html\b/i
const htmlRootPattern = /^<html[\s>]/i

/** Strip script blocks from inbound email HTML before sandboxed preview. */
export function stripDangerousEmailHtml(html: string) {
	return html.replaceAll(
		/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
		'',
	)
}

function isFullHtmlDocument(html: string) {
	const trimmed = html.trimStart()
	return fullHtmlDocumentPattern.test(trimmed) || htmlRootPattern.test(trimmed)
}

function injectReferrerMeta(html: string) {
	const referrerMeta = '<meta name="referrer" content="no-referrer">'
	if (/<head[\s>]/i.test(html)) {
		return html.replace(/<head([^>]*)>/i, `<head$1>${referrerMeta}`)
	}
	return `${referrerMeta}${html}`
}

function wrapEmailHtmlFragment(html: string) {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<base target="_blank" rel="noopener noreferrer">
<style>
html, body { margin: 0; padding: 0; }
body {
	padding: 1rem;
	word-wrap: break-word;
	overflow-wrap: anywhere;
	color: #101010;
	font-family: ui-sans-serif, system-ui, sans-serif;
}
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
</style>
</head>
<body>
${html}
</body>
</html>`
}

/** Build srcdoc HTML for a sandboxed admin email preview iframe. */
export function buildAdminEmailHtmlPreviewDocument(htmlBody: string) {
	const sanitized = stripDangerousEmailHtml(htmlBody)
	if (isFullHtmlDocument(sanitized)) {
		return injectReferrerMeta(sanitized)
	}
	return wrapEmailHtmlFragment(sanitized)
}

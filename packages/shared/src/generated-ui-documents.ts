import {
	absolutizeSrcset,
	absolutizeUrl,
	decodeHtmlAttribute,
	escapeHtmlAttribute,
} from './generated-ui-utils.ts'

export type GeneratedUiDocumentRuntime = 'html' | 'javascript'

export function escapeInlineScriptSource(code: string) {
	return code.replace(/<\/script/gi, '<\\/script')
}

export function injectIntoHtmlDocument(code: string, injection: string) {
	if (/<head\b[^>]*>/i.test(code)) {
		return code.replace(
			/<head\b[^>]*>/i,
			(match) => `${match}\n${injection}\n`,
		)
	}

	if (/<html\b[^>]*>/i.test(code)) {
		return code.replace(
			/<html\b[^>]*>/i,
			(match) => `${match}<head>${injection}</head>`,
		)
	}

	if (/<\/body>/i.test(code)) {
		return code.replace(/<\/body>/i, `${injection}\n</body>`)
	}

	return `${injection}\n${code}`
}

export function absolutizeHtmlAttributeUrls(
	code: string,
	baseHref: string | null,
) {
	if (!baseHref) {
		return code
	}

	return code.replace(/<[^>]+>/g, (tag) => {
		if (
			tag.startsWith('<!--') ||
			tag.startsWith('<!') ||
			tag.startsWith('<?')
		) {
			return tag
		}

		return tag.replace(
			/(^|\s)(href|src|action|formaction|poster|srcset)=("([^"]*)"|'([^']*)')/gi,
			(
				match,
				prefix,
				attributeName,
				quotedValue,
				doubleQuotedValue,
				singleQuotedValue,
			) => {
				const rawValue =
					typeof doubleQuotedValue === 'string'
						? doubleQuotedValue
						: singleQuotedValue
				const decodedValue = decodeHtmlAttribute(rawValue)
				const nextValue =
					attributeName.toLowerCase() === 'srcset'
						? absolutizeSrcset(decodedValue, baseHref)
						: absolutizeUrl(decodedValue, baseHref)

				if (nextValue === decodedValue) {
					return match
				}

				const quote = quotedValue.startsWith('"') ? '"' : "'"
				return `${prefix}${attributeName}=${quote}${escapeHtmlAttribute(nextValue)}${quote}`
			},
		)
	})
}

function buildHtmlDocumentFromFragment(code: string, headInjection: string) {
	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${headInjection}
	</head>
	<body data-kody-runtime="fragment">
${code}
	</body>
</html>
	`.trim()
}

function buildJavascriptDocument(code: string, headInjection: string) {
	const safeCode = escapeInlineScriptSource(code)
	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${headInjection}
	</head>
	<body data-kody-runtime="javascript">
		<div id="app" data-generated-ui-root></div>
		<script type="module">
${safeCode}
		</script>
	</body>
</html>
	`.trim()
}

export function renderGeneratedUiDocument(input: {
	code: string
	runtime: GeneratedUiDocumentRuntime
	headInjection: string
	baseHref: string | null
}) {
	if (input.runtime === 'javascript') {
		return buildJavascriptDocument(input.code, input.headInjection)
	}

	const htmlSource = /<(?:!doctype|html|head|body)\b/i.test(input.code)
		? injectIntoHtmlDocument(input.code, input.headInjection)
		: buildHtmlDocumentFromFragment(input.code, input.headInjection)
	return absolutizeHtmlAttributeUrls(htmlSource, input.baseHref)
}

export function renderGeneratedUiErrorDocument(message: string) {
	return `
<!doctype html>
<html lang="en">
	<body style="margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;">
		<pre style="margin:0;white-space:pre-wrap;word-break:break-word;">${message
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')}</pre>
	</body>
</html>
	`.trim()
}

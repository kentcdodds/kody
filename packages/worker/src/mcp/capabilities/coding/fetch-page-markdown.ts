import { createCloudflareRestClient } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { fetchMarkdownPreferredDoc } from './fetch-markdown-doc.ts'

const maxInlineHtmlChars = 2_000_000

export type PageToMarkdownInput = {
	url?: string
	html?: string
	userAgent?: string
	rejectRequestPattern?: Array<string>
	gotoOptions?: {
		waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
	}
}

export type PageToMarkdownResult = {
	source: 'negotiated' | 'browser_rendering'
	markdown: string
	url: string | null
	negotiated: {
		status: number
		contentType: string | null
		markdownTokenEstimate: string | null
	} | null
	browserRendering: {
		apiStatus: number
		mode: 'url' | 'html'
	} | null
}

function readContentTypeMediaType(contentType: string | null) {
	return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? null
}

function shouldUseNegotiatedContent(input: {
	status: number
	contentType: string | null
	markdownTokenEstimate: string | null
}) {
	if (input.status < 200 || input.status >= 300) return false
	const mediaType = readContentTypeMediaType(input.contentType)
	if (mediaType === 'text/markdown' || mediaType === 'text/plain') return true
	return input.markdownTokenEstimate != null
}

function readConfiguredCloudflareAccountId(
	env: Pick<Env, 'CLOUDFLARE_ACCOUNT_ID'>,
) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	if (!accountId) {
		throw new Error(
			'CLOUDFLARE_ACCOUNT_ID is not set. page_to_markdown uses Cloudflare Browser Rendering as a billed fallback when negotiation does not return markdown or plain text.',
		)
	}
	return accountId
}

type BrowserRenderingResponseBody = {
	success?: boolean
	result?: unknown
	errors?: Array<{ message?: string }>
}

function readBrowserRenderingErrorMessage(body: BrowserRenderingResponseBody) {
	const messages = Array.isArray(body.errors)
		? body.errors
				.map((error) => error?.message?.trim())
				.filter((message): message is string => Boolean(message))
		: []
	return messages.join('; ')
}

async function convertWithBrowserRendering(
	env: Pick<
		Env,
		'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_BASE_URL' | 'CLOUDFLARE_ACCOUNT_ID'
	>,
	input: {
		url?: string
		html?: string
		userAgent?: string
		rejectRequestPattern?: Array<string>
		gotoOptions?: {
			waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
		}
	},
) {
	const accountId = readConfiguredCloudflareAccountId(env)
	const client = createCloudflareRestClient(env)
	const response = await client.rawRequest({
		method: 'POST',
		path: `/client/v4/accounts/${accountId}/browser-rendering/markdown`,
		body: {
			...(input.url ? { url: input.url } : {}),
			...(input.html ? { html: input.html } : {}),
			...(input.userAgent ? { userAgent: input.userAgent } : {}),
			...(input.rejectRequestPattern
				? { rejectRequestPattern: input.rejectRequestPattern }
				: {}),
			...(input.gotoOptions ? { gotoOptions: input.gotoOptions } : {}),
		},
	})
	const body = (response.body ?? {}) as BrowserRenderingResponseBody
	if (body.success !== true || typeof body.result !== 'string') {
		const details = readBrowserRenderingErrorMessage(body)
		throw new Error(
			details.length > 0
				? `Cloudflare Browser Rendering markdown failed (${response.status}): ${details}`
				: `Cloudflare Browser Rendering markdown failed (${response.status}).`,
		)
	}
	return {
		apiStatus: response.status,
		markdown: body.result,
		mode: input.html ? ('html' as const) : ('url' as const),
	}
}

export function assertSafePageToMarkdownUrl(url: string) {
	const trimmed = url.trim()
	if (!trimmed) {
		throw new Error('url cannot be empty.')
	}
	if (/[\s]/.test(trimmed)) {
		throw new Error('url must not contain whitespace.')
	}
	if (trimmed.length > 2048) {
		throw new Error('url exceeds maximum length.')
	}
	const parsed = new URL(trimmed)
	if (parsed.username || parsed.password) {
		throw new Error('url must not include embedded credentials.')
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('url must use http or https.')
	}
	return parsed.toString()
}

export function assertSafePageToMarkdownHtml(html: string) {
	const trimmed = html.trim()
	if (!trimmed) {
		throw new Error('html cannot be empty.')
	}
	if (trimmed.length > maxInlineHtmlChars) {
		throw new Error(
			`html exceeds maximum length of ${maxInlineHtmlChars} characters.`,
		)
	}
	return trimmed
}

export async function fetchNegotiatedThenMaybeBrowserRender(
	env: Pick<
		Env,
		'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_BASE_URL' | 'CLOUDFLARE_ACCOUNT_ID'
	>,
	input: PageToMarkdownInput,
): Promise<PageToMarkdownResult> {
	if (input.html) {
		const browserRendering = await convertWithBrowserRendering(env, {
			html: assertSafePageToMarkdownHtml(input.html),
			userAgent: input.userAgent,
			rejectRequestPattern: input.rejectRequestPattern,
			gotoOptions: input.gotoOptions,
		})
		return {
			source: 'browser_rendering',
			markdown: browserRendering.markdown,
			url: null,
			negotiated: null,
			browserRendering: {
				apiStatus: browserRendering.apiStatus,
				mode: browserRendering.mode,
			},
		}
	}

	const safeUrl = assertSafePageToMarkdownUrl(input.url ?? '')
	const negotiated = await fetchMarkdownPreferredDoc(safeUrl)
	if (shouldUseNegotiatedContent(negotiated)) {
		return {
			source: 'negotiated',
			markdown: negotiated.body,
			url: safeUrl,
			negotiated: {
				status: negotiated.status,
				contentType: negotiated.contentType,
				markdownTokenEstimate: negotiated.markdownTokenEstimate,
			},
			browserRendering: null,
		}
	}

	const browserRendering = await convertWithBrowserRendering(env, {
		url: safeUrl,
		userAgent: input.userAgent,
		rejectRequestPattern: input.rejectRequestPattern,
		gotoOptions: input.gotoOptions,
	})
	return {
		source: 'browser_rendering',
		markdown: browserRendering.markdown,
		url: safeUrl,
		negotiated: {
			status: negotiated.status,
			contentType: negotiated.contentType,
			markdownTokenEstimate: negotiated.markdownTokenEstimate,
		},
		browserRendering: {
			apiStatus: browserRendering.apiStatus,
			mode: browserRendering.mode,
		},
	}
}


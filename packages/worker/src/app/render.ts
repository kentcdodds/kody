import { type SafeHtml } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'

export function render(body: string | SafeHtml, init?: ResponseInit) {
	return createHtmlResponse(body, init)
}

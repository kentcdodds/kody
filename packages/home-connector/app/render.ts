import { createHtmlResponse } from 'remix/response/html'

export function render(body: string, init?: ResponseInit) {
	return createHtmlResponse(body, init)
}

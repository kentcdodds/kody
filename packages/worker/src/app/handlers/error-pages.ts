import { type Action } from 'remix/router'
import { buildNotFoundMarkdown } from '#app/agent-discovery.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	INTERNAL_ERROR_DOCUMENT_TITLE,
	NOT_FOUND_DOCUMENT_TITLE,
} from '#universal/document-head.ts'
import { type routes } from '#universal/routes.ts'

export async function renderIllustratedNotFoundPage(input: {
	request: Request
	env: Env
}) {
	if (prefersMarkdown(input.request)) {
		const origin = getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		})
		return markdownResponse(buildNotFoundMarkdown(origin), 404)
	}
	return withVaryAccept(
		await renderAppPage({
			request: input.request,
			env: input.env,
			title: NOT_FOUND_DOCUMENT_TITLE,
			notFound: true,
			status: 404,
		}),
	)
}

export function renderIllustratedInternalErrorPage(input: {
	request: Request
	env: Env
}) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: INTERNAL_ERROR_DOCUMENT_TITLE,
		internalError: true,
		status: 500,
	})
}

export function createNotFoundPageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderIllustratedNotFoundPage({ request, env })
		},
	} satisfies Action<typeof routes.notFoundPage>
}

export function createInternalErrorPageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderIllustratedInternalErrorPage({ request, env })
		},
	} satisfies Action<typeof routes.internalErrorPage>
}

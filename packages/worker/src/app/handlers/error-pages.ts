import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	INTERNAL_ERROR_DOCUMENT_TITLE,
	NOT_FOUND_DOCUMENT_TITLE,
} from '#universal/document-head.ts'
import { type routes } from '#universal/routes.ts'

export function renderIllustratedNotFoundPage(input: {
	request: Request
	env: Env
}) {
	return renderAppPage({
		request: input.request,
		env: input.env,
		title: NOT_FOUND_DOCUMENT_TITLE,
		notFound: true,
		status: 404,
	})
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

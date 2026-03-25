import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type routes } from '#app/routes.ts'
import { createChatThreadsStore } from '#app/chat-threads.ts'
import { type AppEnv } from '#worker/env-schema.ts'

function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...init?.headers,
		},
	})
}

export function createChatThreadsHandler(appEnv: AppEnv) {
	const store = createChatThreadsStore(appEnv.APP_DB)

	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, appEnv as Env)
			if (!user) {
				return jsonResponse(
					{ ok: false, error: 'Unauthorized' },
					{ status: 401 },
				)
			}

			if (request.method === 'GET') {
				const url = new URL(request.url)
				const threadId = url.searchParams.get('threadId')?.trim() ?? ''
				if (threadId) {
					const thread = await store.getForUser(user.userId, threadId)
					if (!thread) {
						return jsonResponse(
							{ ok: false, error: 'Thread not found.' },
							{ status: 404 },
						)
					}
					return jsonResponse({ ok: true, thread })
				}

				const cursor = url.searchParams.get('cursor')
				const limitParam = url.searchParams.get('limit')?.trim() ?? ''
				const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined
				const search = url.searchParams.get('q')?.trim() ?? ''
				const page = await store.listForUser(user.userId, {
					cursor,
					limit,
					search,
				})
				return jsonResponse({ ok: true, ...page })
			}

			const thread = await store.createForUser(user.userId)
			return jsonResponse({ ok: true, thread }, { status: 201 })
		},
	} satisfies BuildAction<
		typeof routes.chatThreadsCreate.method | typeof routes.chatThreads.method,
		typeof routes.chatThreads.pattern
	>
}

export function createDeleteChatThreadHandler(appEnv: AppEnv) {
	const store = createChatThreadsStore(appEnv.APP_DB)

	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, appEnv as Env)
			if (!user) {
				return jsonResponse(
					{ ok: false, error: 'Unauthorized' },
					{ status: 401 },
				)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse(
					{ ok: false, error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}

			const threadId =
				body &&
				typeof body === 'object' &&
				typeof (body as { threadId?: unknown }).threadId === 'string'
					? (body as { threadId: string }).threadId.trim()
					: ''
			if (!threadId) {
				return jsonResponse(
					{ ok: false, error: 'Thread ID is required.' },
					{ status: 400 },
				)
			}

			const deleted = await store.markDeletedForUser(user.userId, threadId)
			if (!deleted) {
				return jsonResponse(
					{ ok: false, error: 'Thread not found.' },
					{ status: 404 },
				)
			}

			return jsonResponse({ ok: true })
		},
	} satisfies BuildAction<
		typeof routes.chatThreadsDelete.method,
		typeof routes.chatThreadsDelete.pattern
	>
}

export function createUpdateChatThreadHandler(appEnv: AppEnv) {
	const store = createChatThreadsStore(appEnv.APP_DB)

	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, appEnv as Env)
			if (!user) {
				return jsonResponse(
					{ ok: false, error: 'Unauthorized' },
					{ status: 401 },
				)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse(
					{ ok: false, error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}

			const threadId =
				body &&
				typeof body === 'object' &&
				typeof (body as { threadId?: unknown }).threadId === 'string'
					? (body as { threadId: string }).threadId.trim()
					: ''
			const title =
				body &&
				typeof body === 'object' &&
				typeof (body as { title?: unknown }).title === 'string'
					? (body as { title: string }).title.trim()
					: ''
			if (!threadId) {
				return jsonResponse(
					{ ok: false, error: 'Thread ID is required.' },
					{ status: 400 },
				)
			}
			if (!title) {
				return jsonResponse(
					{ ok: false, error: 'Title is required.' },
					{ status: 400 },
				)
			}

			const thread = await store.renameForUser(user.userId, threadId, title)
			if (!thread) {
				return jsonResponse(
					{ ok: false, error: 'Thread not found.' },
					{ status: 404 },
				)
			}

			return jsonResponse({ ok: true, thread })
		},
	} satisfies BuildAction<
		typeof routes.chatThreadsUpdate.method,
		typeof routes.chatThreadsUpdate.pattern
	>
}

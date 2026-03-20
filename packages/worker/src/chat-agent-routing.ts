import { getAgentByName, routeAgentRequest } from 'agents'
import { readAuthenticatedAppUser } from '../../../server/authenticated-user.ts'
import { createChatThreadsStore } from '../../../server/chat-threads.ts'
import { chatAgentBasePath } from '../../../shared/chat-routes.ts'

function createJsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...init?.headers,
		},
	})
}

function getThreadIdFromPath(pathname: string) {
	if (!pathname.startsWith(`${chatAgentBasePath}/`)) return null
	const pathAfterBase = pathname.slice(chatAgentBasePath.length + 1)
	const [threadId] = pathAfterBase.split('/')
	return threadId?.trim() || null
}

function getSubPathFromPath(pathname: string) {
	if (!pathname.startsWith(`${chatAgentBasePath}/`)) return ''
	const pathAfterBase = pathname.slice(chatAgentBasePath.length + 1)
	const [, ...subPathSegments] = pathAfterBase.split('/')
	return subPathSegments.length > 0 ? `/${subPathSegments.join('/')}` : ''
}

function parseOptionalInteger(value: string | null) {
	if (!value) return undefined
	const parsedValue = Number.parseInt(value, 10)
	return Number.isFinite(parsedValue) ? parsedValue : undefined
}

export async function handleChatAgentRequest(request: Request, env: Env) {
	const url = new URL(request.url)
	const threadId = getThreadIdFromPath(url.pathname)
	if (!threadId) {
		return createJsonResponse(
			{ ok: false, error: 'Thread ID is required.' },
			{ status: 400 },
		)
	}

	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return createJsonResponse(
			{ ok: false, error: 'Unauthorized' },
			{ status: 401 },
		)
	}

	const threadStore = createChatThreadsStore(env.APP_DB)
	const thread = await threadStore.getForUser(user.userId, threadId)
	if (!thread) {
		return createJsonResponse(
			{ ok: false, error: 'Thread not found.' },
			{ status: 404 },
		)
	}

	const subPath = getSubPathFromPath(url.pathname)
	if (request.method === 'GET' && subPath === '/get-messages') {
		const chatAgent = await getAgentByName(env.ChatAgent, threadId)
		const page = (await chatAgent.getMessagePage({
			before: parseOptionalInteger(url.searchParams.get('before')),
			limit: parseOptionalInteger(url.searchParams.get('limit')),
			start: parseOptionalInteger(url.searchParams.get('start')),
		})) as {
			hasMore: boolean
			messages: Array<unknown>
			nextBefore: string | null
			startIndex: number
			totalCount: number
		}
		return createJsonResponse({
			ok: true,
			messages: page.messages,
			hasMore: page.hasMore,
			nextBefore: page.nextBefore,
			startIndex: page.startIndex,
			totalCount: page.totalCount,
		})
	}

	return (
		(await routeAgentRequest(request, env)) ??
		createJsonResponse({ ok: false, error: 'Not found.' }, { status: 404 })
	)
}

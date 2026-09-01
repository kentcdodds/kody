import { getOidcJwksDocument } from '#worker/oidc/keys.ts'

export async function handleOidcJwksRequest(request: Request, env: Env) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405 })
	}
	const body = JSON.stringify(await getOidcJwksDocument(env))
	const headers = {
		'Cache-Control': 'public, max-age=3600',
		'Content-Type': 'application/json; charset=utf-8',
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return new Response(body, { status: 200, headers })
}

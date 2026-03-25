import { handleConnectionOAuthCallback } from './connection-service.ts'

export function isConnectionOAuthRequest(pathname: string) {
	return pathname === '/api/connections/oauth/callback'
}

export async function handleConnectionOAuthRequest(
	request: Request,
	env: Env,
) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed.', { status: 405 })
	}
	const response = await handleConnectionOAuthCallback(request, env)
	if (request.method === 'HEAD') {
		return new Response(null, {
			status: response.status,
			headers: response.headers,
		})
	}
	return response
}

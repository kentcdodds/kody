import { handleConnectionOAuthCallback } from './connection-service.ts'

export function isConnectionOAuthRequest(pathname: string) {
	return pathname === '/api/connections/oauth/callback'
}

export async function handleConnectionOAuthRequest(request: Request, env: Env) {
	if (request.method !== 'GET') {
		return new Response('Method not allowed.', { status: 405 })
	}
	return handleConnectionOAuthCallback(request, env)
}

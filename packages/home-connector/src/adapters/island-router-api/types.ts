export type IslandRouterApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type IslandRouterApiRequestInput = {
	method: IslandRouterApiMethod
	path: string
	query?: Record<string, unknown>
	body?: unknown
	timeoutMs?: number
}

export type IslandRouterApiRequestResult = {
	method: IslandRouterApiMethod
	path: string
	query: Record<string, unknown> | null
	status: number
	data: unknown
}

export type IslandRouterApiAuthTokens = {
	session: string
	access: string
	refresh: string
}

export type IslandRouterApiFetch = typeof fetch

export type IslandRouterApiStatus = {
	configured: boolean
	hasStoredPin: boolean
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
	baseUrl: string
}

export type IslandRouterApiCredentials = {
	pin: string | null
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

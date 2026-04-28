export type AccountStatus = 'loading' | 'ready' | 'error'
export type ApprovalAction = 'approve' | 'reject'
export type ApprovalScope = 'session' | 'app' | 'user'

export type ApprovalView = {
	name: string
	scope: ApprovalScope
	requestedHost: string
	requestedCapability: string | null
	currentAllowedHosts: Array<string>
	requestedPackageId: string | null
	currentAllowedPackages: Array<string>
}

export const accountSecretsApiPath = '/account/secrets.json'

export function getScopeLabel(scope: ApprovalScope) {
	if (scope === 'app') return 'App'
	if (scope === 'session') return 'Session'
	return 'User'
}

export async function readJson<T>(response: Response) {
	return (await response.json().catch(() => null)) as T | null
}

export async function submitApprovalRequest<
	T extends { ok?: boolean; error?: string },
>(action: ApprovalAction, requestUrl = accountSecretsApiPath) {
	const response = await fetch(requestUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			action,
		}),
	})
	if (response.status === 401) {
		window.location.assign('/login')
		return null
	}
	const payload = await readJson<T>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to process approval.')
	}
	return payload
}

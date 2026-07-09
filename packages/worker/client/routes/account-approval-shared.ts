import { parseAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'

export type AccountStatus = 'loading' | 'ready' | 'error'
export type ApprovalAction = 'approve' | 'reject'
export type ApprovalScope = 'session' | 'package' | 'user'

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
export const accountProfileApiPath = '/account/profile.json'

export function getScopeLabel(scope: ApprovalScope) {
	if (scope === 'package') return 'Package'
	if (scope === 'session') return 'Session'
	return 'User'
}

export async function readJson<T>(response: Response) {
	return (await response.json().catch(() => null)) as T | null
}

export function buildHostApprovalRequestUrl(
	approvalUrl: string,
	baseUrl = 'http://localhost',
) {
	const approvalPageUrl = new URL(approvalUrl, baseUrl)
	const parsedPath = parseAccountSecretPath(approvalPageUrl.pathname)
	if (!parsedPath) {
		throw new Error('Invalid approval link.')
	}
	const requestUrl = new URL(accountSecretsApiPath, baseUrl)
	requestUrl.search = approvalPageUrl.search
	requestUrl.searchParams.set('selected', parsedPath.id)
	return `${requestUrl.pathname}${requestUrl.search}`
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

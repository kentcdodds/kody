import {
	accountProfileApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AccountConnectedAgentsLoaderData,
	type AccountConnectionsLoaderData,
	type AccountProfileLoaderData,
} from '#universal/loader-data.ts'

const connectionsApiPath = '/account/connections.json'
export const connectedAgentsApiPath = '/account/connected-agents.json'

export type AccountPagePayloads = {
	accountProfile: AccountProfileLoaderData
	accountConnections: AccountConnectionsLoaderData
	accountConnectedAgents: AccountConnectedAgentsLoaderData
	onboarding: OnboardingPayload | null
}

export async function fetchAccountPagePayloads(
	search: string,
	signal: AbortSignal,
): Promise<
	{ kind: 'unauthorized' } | { kind: 'ok'; payloads: AccountPagePayloads }
> {
	const [
		profileResponse,
		connectionsResponse,
		connectedAgentsResponse,
		onboarding,
	] = await Promise.all([
		fetch(`${accountProfileApiPath}${search}`, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetch(connectionsApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetch(connectedAgentsApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetchOnboardingPayload(signal),
	])
	if (
		profileResponse.status === 401 ||
		connectionsResponse.status === 401 ||
		connectedAgentsResponse.status === 401
	) {
		return { kind: 'unauthorized' }
	}
	const [payload, connectionsPayload, connectedAgentsPayload] =
		await Promise.all([
			readJson<AccountProfileLoaderData>(profileResponse),
			readJson<AccountConnectionsLoaderData>(connectionsResponse),
			readJson<AccountConnectedAgentsLoaderData>(connectedAgentsResponse),
		])
	if (!profileResponse.ok || !payload?.ok) {
		throw new Error('Unable to load your account.')
	}
	if (!connectionsResponse.ok || !connectionsPayload?.ok) {
		throw new Error('Unable to load connected accounts.')
	}
	if (!connectedAgentsResponse.ok || !connectedAgentsPayload?.ok) {
		throw new Error('Unable to load connected agents.')
	}
	return {
		kind: 'ok',
		payloads: {
			accountProfile: payload,
			accountConnections: connectionsPayload,
			accountConnectedAgents: connectedAgentsPayload,
			onboarding,
		},
	}
}

export async function accountRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await fetchAccountPagePayloads(url.search, signal)
	if (result.kind === 'unauthorized') {
		return routeLoaderRedirect('/login')
	}
	return {
		accountProfile: result.payloads.accountProfile,
		accountConnections: result.payloads.accountConnections,
		accountConnectedAgents: result.payloads.accountConnectedAgents,
		...(result.payloads.onboarding
			? { onboarding: result.payloads.onboarding }
			: {}),
	}
}

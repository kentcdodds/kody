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
	type AccountConnectionsLoaderData,
	type AccountEmailDestinationsLoaderData,
	type AccountProfileLoaderData,
} from '#universal/loader-data.ts'

const connectionsApiPath = '/account/connections.json'
const destinationsApiPath = '/account/email-destinations.json'
export const connectedAgentsApiPath = '/account/connected-agents.json'

export type AccountPagePayloads = {
	accountProfile: AccountProfileLoaderData
	accountConnections: AccountConnectionsLoaderData
	accountEmailDestinations: AccountEmailDestinationsLoaderData
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
		destinationsResponse,
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
		fetch(destinationsApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetchOnboardingPayload(signal),
	])
	if (
		profileResponse.status === 401 ||
		connectionsResponse.status === 401 ||
		destinationsResponse.status === 401
	) {
		return { kind: 'unauthorized' }
	}
	const [payload, connectionsPayload, destinationsPayload] = await Promise.all([
		readJson<AccountProfileLoaderData>(profileResponse),
		readJson<AccountConnectionsLoaderData>(connectionsResponse),
		readJson<AccountEmailDestinationsLoaderData>(destinationsResponse),
	])
	if (!profileResponse.ok || !payload?.ok) {
		throw new Error('Unable to load your account.')
	}
	if (!connectionsResponse.ok || !connectionsPayload?.ok) {
		throw new Error('Unable to load connected accounts.')
	}
	if (!destinationsResponse.ok || !destinationsPayload?.ok) {
		throw new Error('Unable to load notification destinations.')
	}
	return {
		kind: 'ok',
		payloads: {
			accountProfile: payload,
			accountConnections: connectionsPayload,
			accountEmailDestinations: destinationsPayload,
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
		accountEmailDestinations: result.payloads.accountEmailDestinations,
		...(result.payloads.onboarding
			? { onboarding: result.payloads.onboarding }
			: {}),
	}
}

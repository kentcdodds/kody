import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	readOnboardingChecklistDismissed,
	userHasSentWelcomeEmail,
} from '#mcp/onboarding-checklist.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadOnboardingFeaturedListings,
	loadOnboardingMcpChooserListings,
} from '#app/community-data.ts'
import {
	listOwnerEmailMessages,
	searchOwnerEmailMessages,
} from '#worker/email/owner-email-reader.ts'
import {
	buildMcpServerStatusView,
	loadMcpClientHubSnapshotOrNull,
} from '#mcp/capabilities/mcp-servers/shared.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import {
	attachOnboardingMcpPackageListings,
	firstConnectedOnboardingWorkspaceLabel,
	listDisconnectedOnboardingFeaturedMcpServers,
	listOnboardingCustomMcpServers,
	overlayOnboardingFeaturedMcpServers,
} from '#universal/onboarding-mcp-chooser.ts'
import { firstInstalledOnboardingExampleName } from '#universal/onboarding-examples.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
	type OnboardingWelcomeEmail,
	type OnboardingLoaderData,
} from '#universal/loader-data.ts'
import {
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'
import { anonymousPersonalizedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	highlightResultsByKey,
	highlightSnippets,
} from '#app/highlight-code.ts'
import { collectOnboardingMcpSnippets } from '#universal/onboarding-mcp-clients.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

/**
 * The checklist derives from existing signals (mailbox, memories,
 * integrations, saved packages), so it only computes for verified users —
 * unverified accounts have nothing to derive and should not pay the probes.
 */
export async function loadChecklist(
	env: Env,
	userId: string,
	hasMcpClient: boolean,
): Promise<OnboardingChecklistLoaderData> {
	const [checklist, dismissed] = await Promise.all([
		deriveOnboardingChecklist({
			env,
			userId,
			emailVerified: true,
			hasMcpClient,
		}),
		readOnboardingChecklistDismissed({ env, userId }),
	])
	return { items: checklist.items, dismissed }
}

/**
 * First-win Send sub-step: successful `email_send` or stored outbound mail.
 * Fails open to false so a Mailbox or UserMeter blip never breaks the payload.
 */
async function loadHasSentWelcomeEmail(
	env: Env,
	userId: string,
): Promise<boolean> {
	return await userHasSentWelcomeEmail({ env, userId })
}

/**
 * Subject fragment the `first-win` guide tells agents to use. Matching on it
 * first means a mailbox that already holds other outbound mail still surfaces
 * the welcome message instead of whatever was sent most recently.
 */
const welcomeEmailSubjectMatch = 'Welcome to Kody'

/**
 * Subject and sender of the stored welcome email, so the Reply sub-step can
 * name exactly what to search a personal inbox for. Agents write their own
 * subject line, so a mailbox with no match falls back to the newest outbound
 * message — during the first win that is the mail to reply to. Fails open to
 * null: the sub-step reads fine without it, and a Mailbox blip must not break
 * the payload.
 */
/**
 * Most recently updated saved-package kody id for Step 3 next-steps after
 * persist. The listing is `ORDER BY updated_at DESC`, so the first row is
 * the package the user just saved. Fails open to null so a D1 blip never
 * breaks the onboarding payload.
 */
export async function loadPersistedPackageKodyId(
	env: Pick<Env, 'APP_DB'>,
	userId: string,
): Promise<string | null> {
	try {
		const packages = await listSavedPackagesByUserId(env.APP_DB, { userId })
		return packages[0]?.kodyId ?? null
	} catch {
		return null
	}
}

export async function loadWelcomeEmail(
	env: Env,
	userId: string,
): Promise<OnboardingWelcomeEmail | null> {
	try {
		const [matched] = await searchOwnerEmailMessages({
			env,
			ownerId: userId,
			direction: 'outbound',
			query: welcomeEmailSubjectMatch,
			limit: 1,
		})
		const message =
			matched ??
			(
				await listOwnerEmailMessages({
					env,
					ownerId: userId,
					direction: 'outbound',
					limit: 1,
				})
			)[0]
		if (!message?.subject) return null
		return { subject: message.subject, fromAddress: message.fromAddress }
	} catch {
		return null
	}
}

/**
 * Official workspace MCP chooser cards for the wizard. When `userId` is set,
 * overlays saved MCP servers and hub connection state. Fails open to the
 * disconnected catalog so a hub or D1 blip never breaks the payload.
 */
async function loadOnboardingMcpChooserOverlay(
	env: Env,
	userId?: string | null,
) {
	if (!userId) return { settings: [], statusByServerId: undefined }
	try {
		const settings = await listMcpServerSettings({ env, userId })
		if (settings.length === 0) {
			return { settings: [], statusByServerId: undefined }
		}
		const snapshot = await loadMcpClientHubSnapshotOrNull({ env, userId })
		const statusByServerId = new Map(
			settings.map((setting) => {
				const view = buildMcpServerStatusView({
					setting,
					snapshot:
						snapshot?.servers.find(
							(server) => server.serverId === setting.id,
						) ?? null,
				})
				return [
					setting.id,
					{
						connected: view.connected,
						authUrl: view.authUrl,
						state: view.state,
						error: view.error,
					},
				] as const
			}),
		)
		return { settings, statusByServerId }
	} catch {
		return { settings: [], statusByServerId: undefined }
	}
}

export async function loadOnboardingFeaturedMcpServers(
	env: Env,
	userId?: string | null,
): Promise<Array<OnboardingFeaturedMcpServer>> {
	if (!userId) return listDisconnectedOnboardingFeaturedMcpServers()
	try {
		const overlay = await loadOnboardingMcpChooserOverlay(env, userId)
		if (overlay.settings.length === 0) {
			return listDisconnectedOnboardingFeaturedMcpServers()
		}
		return overlayOnboardingFeaturedMcpServers(overlay)
	} catch {
		return listDisconnectedOnboardingFeaturedMcpServers()
	}
}

export async function loadOnboardingCustomMcpServers(
	env: Env,
	userId?: string | null,
): Promise<Array<OnboardingCustomMcpServer>> {
	if (!userId) return []
	const overlay = await loadOnboardingMcpChooserOverlay(env, userId)
	return listOnboardingCustomMcpServers(overlay)
}

async function loadOnboardingChooserMcpState(
	env: Env,
	request: Request,
	userId?: string | null,
): Promise<{
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
}> {
	const [overlay, listings] = await Promise.all([
		loadOnboardingMcpChooserOverlay(env, userId),
		loadOnboardingMcpChooserListings(env, request),
	])
	const featuredBase =
		overlay.settings.length === 0
			? listDisconnectedOnboardingFeaturedMcpServers()
			: overlayOnboardingFeaturedMcpServers(overlay)
	return {
		featuredMcpServers: attachOnboardingMcpPackageListings(
			featuredBase,
			listings,
		),
		customMcpServers: listOnboardingCustomMcpServers(overlay),
	}
}

async function loadOnboardingChooserFields(
	env: Env,
	request: Request,
	userId?: string | null,
) {
	const [featuredListings, chooser] = await Promise.all([
		loadOnboardingFeaturedListings(env, request),
		loadOnboardingChooserMcpState(env, request, userId),
	])
	return {
		featuredListings,
		featuredMcpServers: chooser.featuredMcpServers,
		customMcpServers: chooser.customMcpServers,
		persistContext: {
			connectedWorkspaceLabel: firstConnectedOnboardingWorkspaceLabel({
				featuredMcpServers: chooser.featuredMcpServers,
				customMcpServers: chooser.customMcpServers,
			}),
			installedExampleName:
				firstInstalledOnboardingExampleName(featuredListings),
		},
	}
}

function redirectUnverifiedToPending(request: Request) {
	const requestUrl = new URL(request.url)
	const redirectTo = normalizeRedirectTo(
		requestUrl.searchParams.get('redirectTo'),
	)
	const pendingUrl = new URL('/pending-verification', requestUrl)
	if (redirectTo) {
		pendingUrl.searchParams.set('redirectTo', redirectTo)
	}
	return Response.redirect(pendingUrl, 302)
}

async function withOnboardingHighlights(
	env: Env,
	data: OnboardingLoaderData,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<OnboardingLoaderData> {
	if (!data.mcpServerUrl) {
		return { ...data, mcpHighlights: {} }
	}
	const snippets = collectOnboardingMcpSnippets(data.mcpServerUrl)
	const results = await highlightSnippets(env, snippets, { serverTiming })
	return {
		...data,
		mcpHighlights: highlightResultsByKey(snippets, results),
	}
}

export function createOnboardingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const serverTiming: Array<ServerTimingEntry> = []
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				const { persistContext: _persistContext, ...chooser } =
					await pushServerTiming(serverTiming, 'listings', () =>
						loadOnboardingChooserFields(env, request),
					)
				const onboarding = await withOnboardingHighlights(
					env,
					{
						...loadPublicOnboardingData({
							env,
							requestUrl: request.url,
						}),
						...chooser,
					},
					serverTiming,
				)
				return renderAppPage({
					request,
					env,
					loaderData: { onboarding },
					serverTiming,
				})
			}

			if (!user.emailVerified) {
				return redirectUnverifiedToPending(request)
			}

			const chooser = await pushServerTiming(serverTiming, 'listings', () =>
				loadOnboardingChooserFields(env, request, user.mcpUser.userId),
			)
			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				username: user.username,
				emailVerified: user.emailVerified,
				...chooser,
			})
			;[
				onboarding.checklist,
				onboarding.hasSentWelcomeEmail,
				onboarding.welcomeEmail,
				onboarding.persistedPackageKodyId,
			] = await Promise.all([
				loadChecklist(env, user.mcpUser.userId, onboarding.hasMcpClient),
				loadHasSentWelcomeEmail(env, user.mcpUser.userId),
				loadWelcomeEmail(env, user.mcpUser.userId),
				loadPersistedPackageKodyId(env, user.mcpUser.userId),
			])
			return renderAppPage({
				request,
				env,
				loaderData: {
					onboarding: await withOnboardingHighlights(
						env,
						onboarding,
						serverTiming,
					),
				},
				serverTiming,
			})
		},
	} satisfies Action<typeof routes.onboarding>
}

export function createOnboardingApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const serverTiming: Array<ServerTimingEntry> = []
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				const { persistContext: _persistContext, ...chooser } =
					await pushServerTiming(serverTiming, 'listings', () =>
						loadOnboardingChooserFields(env, request),
					)
				return jsonResponse(
					await withOnboardingHighlights(
						env,
						{
							...loadPublicOnboardingData({
								env,
								requestUrl: request.url,
							}),
							...chooser,
						},
						serverTiming,
					),
					{
						serverTiming,
						headers: anonymousPersonalizedJsonCacheHeaders({
							personalized: false,
							request,
						}),
					},
				)
			}

			// Unverified callers still get a payload so clients can detect the
			// gate; MCP URL/setup and featured fields stay empty until
			// verification succeeds.
			const chooser = user.emailVerified
				? await pushServerTiming(serverTiming, 'listings', () =>
						loadOnboardingChooserFields(env, request, user.mcpUser.userId),
					)
				: null
			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				username: user.username,
				emailVerified: user.emailVerified,
				...chooser,
			})
			if (user.emailVerified) {
				;[
					onboarding.checklist,
					onboarding.hasSentWelcomeEmail,
					onboarding.welcomeEmail,
					onboarding.persistedPackageKodyId,
				] = await Promise.all([
					loadChecklist(env, user.mcpUser.userId, onboarding.hasMcpClient),
					loadHasSentWelcomeEmail(env, user.mcpUser.userId),
					loadWelcomeEmail(env, user.mcpUser.userId),
					loadPersistedPackageKodyId(env, user.mcpUser.userId),
				])
			}
			return jsonResponse(
				await withOnboardingHighlights(env, onboarding, serverTiming),
				{ serverTiming },
			)
		},
	} satisfies Action<typeof routes.onboardingApi>
}

export function createOnboardingChecklistDismissHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Sign in required.' }, 401)
			}
			await dismissOnboardingChecklist({ env, userId: user.mcpUser.userId })
			return jsonResponse({ ok: true })
		},
	} satisfies Action<typeof routes.onboardingChecklistDismissPost>
}

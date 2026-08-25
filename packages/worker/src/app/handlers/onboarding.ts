import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	readOnboardingChecklistDismissed,
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
	userHasMcpOAuthGrants,
} from '#app/onboarding-data.ts'
import { countInternalUserEmailMessages } from '#worker/email/mailbox-internal-read.ts'
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
	options?: { probeMailbox?: boolean },
): Promise<OnboardingChecklistLoaderData> {
	const [checklist, dismissed] = await Promise.all([
		deriveOnboardingChecklist({
			env,
			userId,
			emailVerified: true,
			hasMcpClient,
			probeMailbox: options?.probeMailbox,
		}),
		readOnboardingChecklistDismissed({ env, userId }),
	])
	return { items: checklist.items, dismissed }
}

const emptyOnboardingMailboxSignals = {
	inboundMail: 0,
	hasSentWelcomeEmail: false,
	welcomeEmail: null,
}

/**
 * Mailbox-backed first-win signals. One unfiltered count first: an empty
 * mailbox (the usual first-visit case) returns without a second RPC. Search
 * and list run only when something is stored.
 */
async function loadOnboardingMailboxSignals(
	env: Env,
	userId: string,
): Promise<{
	inboundMail: number
	hasSentWelcomeEmail: boolean
	welcomeEmail: OnboardingWelcomeEmail | null
}> {
	try {
		const total = await countInternalUserEmailMessages({
			env,
			ownerId: userId,
		})
		if (total === 0) return emptyOnboardingMailboxSignals
		const [inboundMail, outboundMail, welcomeEmail] = await Promise.all([
			countInternalUserEmailMessages({
				env,
				ownerId: userId,
				filters: { direction: 'inbound' },
			}),
			countInternalUserEmailMessages({
				env,
				ownerId: userId,
				filters: { direction: 'outbound' },
			}),
			loadWelcomeEmail(env, userId),
		])
		return {
			inboundMail,
			hasSentWelcomeEmail: outboundMail > 0,
			welcomeEmail,
		}
	} catch {
		return emptyOnboardingMailboxSignals
	}
}

function withInboundMail(
	checklist: OnboardingChecklistLoaderData,
	inboundMail: number,
): OnboardingChecklistLoaderData {
	return {
		...checklist,
		items: checklist.items.map((item) =>
			item.id === 'first-hello' ? { ...item, done: inboundMail > 0 } : item,
		),
	}
}

async function loadSignedInOnboardingD1Progress(env: Env, userId: string) {
	const [checklist, persistedPackageKodyId] = await Promise.all([
		loadChecklist(env, userId, false, { probeMailbox: false }),
		loadPersistedPackageKodyId(env, userId),
	])
	return { checklist, persistedPackageKodyId }
}

async function loadSignedInOnboardingMailboxProgress(input: {
	env: Env
	userId: string
	hasMcpClient: boolean
	checklist: OnboardingChecklistLoaderData
	serverTiming: Array<ServerTimingEntry>
}): Promise<{
	checklist: OnboardingChecklistLoaderData
	hasSentWelcomeEmail: boolean
	welcomeEmail: OnboardingWelcomeEmail | null
}> {
	const mailboxStartedAt = Date.now()
	const mailbox = input.hasMcpClient
		? await loadOnboardingMailboxSignals(input.env, input.userId)
		: emptyOnboardingMailboxSignals
	input.serverTiming.push({
		name: 'mailbox',
		durationMs: Date.now() - mailboxStartedAt,
		desc: input.hasMcpClient ? 'probe' : 'skip',
	})
	return {
		checklist: withInboundMail(
			{
				...input.checklist,
				items: input.checklist.items.map((item) =>
					item.id === 'connect-agent'
						? { ...item, done: input.hasMcpClient }
						: item,
				),
			},
			mailbox.inboundMail,
		),
		hasSentWelcomeEmail: mailbox.hasSentWelcomeEmail,
		welcomeEmail: mailbox.welcomeEmail,
	}
}

/**
 * Subject fragment the `first-win` guide tells agents to use. Matching on it
 * first means a mailbox that already holds other outbound mail still surfaces
 * the welcome message instead of whatever was sent most recently.
 */
const welcomeEmailSubjectMatch = 'Welcome to Kody'

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

/**
 * Subject and sender of the stored welcome email, so the Reply sub-step can
 * name exactly what to search a personal inbox for. Agents write their own
 * subject line, so a mailbox with no match falls back to the newest outbound
 * message — during the first win that is the mail to reply to. Fails open to
 * null: the sub-step reads fine without it, and a Mailbox blip must not break
 * the payload.
 */
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

			const [chooser, hasMcpClient, d1Progress] = await Promise.all([
				pushServerTiming(serverTiming, 'listings', () =>
					loadOnboardingChooserFields(env, request, user.mcpUser.userId),
				),
				userHasMcpOAuthGrants(env, user.mcpUser.userId),
				loadSignedInOnboardingD1Progress(env, user.mcpUser.userId),
			])
			const mailboxProgress = await loadSignedInOnboardingMailboxProgress({
				env,
				userId: user.mcpUser.userId,
				hasMcpClient,
				checklist: d1Progress.checklist,
				serverTiming,
			})
			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				username: user.username,
				emailVerified: user.emailVerified,
				hasMcpClient,
				...chooser,
				persistedPackageKodyId: d1Progress.persistedPackageKodyId,
				...mailboxProgress,
			})
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
			const [chooser, hasMcpClient, d1Progress] = user.emailVerified
				? await Promise.all([
						pushServerTiming(serverTiming, 'listings', () =>
							loadOnboardingChooserFields(env, request, user.mcpUser.userId),
						),
						userHasMcpOAuthGrants(env, user.mcpUser.userId),
						loadSignedInOnboardingD1Progress(env, user.mcpUser.userId),
					])
				: [null, false, null]
			const mailboxProgress = d1Progress
				? await loadSignedInOnboardingMailboxProgress({
						env,
						userId: user.mcpUser.userId,
						hasMcpClient,
						checklist: d1Progress.checklist,
						serverTiming,
					})
				: null
			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				username: user.username,
				emailVerified: user.emailVerified,
				hasMcpClient,
				...chooser,
				persistedPackageKodyId: d1Progress?.persistedPackageKodyId,
				...mailboxProgress,
			})
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

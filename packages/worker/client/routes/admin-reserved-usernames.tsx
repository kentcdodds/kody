import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'
import { type AdminReservedUsernamesLoaderData } from '#universal/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'adding' | 'removing'

const adminReservedUsernamesApiPath = '/admin/reserved-usernames.json'
const adminReservedUsernamesPath = '/admin/reserved-usernames'

function isAdminReservedUsernamesPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname === adminReservedUsernamesPath
	)
}

export async function adminReservedUsernamesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(
		`${adminReservedUsernamesApiPath}${url.search}`,
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view reserved usernames.')
	}
	const payload = await readJson<AdminReservedUsernamesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load reserved usernames.')
	}
	return { adminReservedUsernames: payload }
}

export function AdminReservedUsernamesRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let builtIn: Array<string> = []
	let added: Array<string> = []
	let removed: Array<string> = []
	let conflicts: AdminReservedUsernamesLoaderData['conflicts'] = []
	let builtInQuery = ''
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let actionState: ActionState = 'idle'
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null
	let loadRequestId = 0

	function applyData(payload: AdminReservedUsernamesLoaderData) {
		builtIn = payload.builtIn
		added = payload.added
		removed = payload.removed
		conflicts = payload.conflicts
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	async function loadReservedUsernames() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminReservedUsernamesApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view reserved usernames.'
				messageTone = 'error'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminReservedUsernamesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load reserved usernames.')
			}
			applyData(payload)
			lastLoadedHref = href
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load reserved usernames.'
			messageTone = 'error'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	async function submitAdminAction(body: Record<string, unknown>) {
		actionState = body.action === 'add' ? 'adding' : 'removing'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(adminReservedUsernamesApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(body),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminReservedUsernamesLoaderData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error ?? 'Unable to update reserved usernames.',
				)
			}
			applyData(payload)
			message =
				body.action === 'add'
					? 'Reserved usernames updated.'
					: 'Reserved username removed.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to update reserved usernames.'
			messageTone = 'error'
		} finally {
			actionState = 'idle'
			handle.update()
		}
	}

	function handleAddSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		void submitAdminAction({
			action: 'add',
			text: String(formData.get('usernames') ?? ''),
		})
		event.currentTarget.reset()
	}

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const routeData = isAdminReservedUsernamesPath(currentHref)
			? tryConsumeRouteLoaderData(handle, 'adminReservedUsernames', currentHref)
			: undefined
		if (routeData) {
			applyData(routeData)
			lastLoadedHref = currentHref
			lastFailedHref = null
		}
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !routeData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!routeData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadReservedUsernames)
		}
		const isMutating = actionState !== 'idle'
		const normalizedQuery = builtInQuery.trim().toLowerCase()
		const visibleBuiltIn = normalizedQuery
			? builtIn.filter((name) => name.includes(normalizedQuery))
			: builtIn

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Reserved usernames"
					description="Usernames become {username}.kody.run subdomains and {username}@ mail locals. Built-in names stay locked unless explicitly unreserved; system-email locals and kody-prefixed names cannot be unreserved."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading reserved usernames…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<AccountManagementPanel
					title="Add reserved names"
					description="Enter one or more DNS-safe labels, separated by commas or new lines."
					asForm
					onSubmit={handleAddSubmit}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Usernames</span>
						<textarea
							data-field-ring
							name="usernames"
							rows={4}
							placeholder="autodiscover, mta-sts"
							disabled={isMutating}
							mix={css(accountTextareaCss)}
						/>
					</label>
					<button
						type="submit"
						disabled={isMutating}
						mix={css(primaryButtonCss)}
					>
						{actionState === 'adding' ? 'Adding…' : 'Add'}
					</button>
				</AccountManagementPanel>
				<section mix={css(cardCss)}>
					<h2
						mix={css({
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							margin: 0,
						})}
					>
						Conflicts
					</h2>
					<p mix={css(descriptionCss)}>
						Registered accounts whose username is in the effective reserved set.
						Resolve these in production before expanding the built-in list.
					</p>
					{status === 'ready' && conflicts.length === 0 ? (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No registered usernames collide with the effective reserved set.
						</p>
					) : null}
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						{conflicts.map((conflict) => (
							<div
								key={conflict.stableUserId}
								mix={css({
									display: 'flex',
									justifyContent: 'space-between',
									gap: spacing.md,
									flexWrap: 'wrap',
								})}
							>
								<strong>{conflict.username}</strong>
								<IdValue value={conflict.stableUserId} label="stable user id" />
							</div>
						))}
					</div>
				</section>
				<section mix={css(cardCss)}>
					<h2
						mix={css({
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							margin: 0,
						})}
					>
						Custom additions
					</h2>
					<p mix={css(descriptionCss)}>
						Runtime names stored in platform KV. Removing one makes it available
						again.
					</p>
					{status === 'ready' && added.length === 0 ? (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No custom reserved usernames.
						</p>
					) : null}
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						{added.map((username) => (
							<div
								key={username}
								mix={css({
									display: 'flex',
									justifyContent: 'space-between',
									alignItems: 'center',
									gap: spacing.md,
								})}
							>
								<code>{username}</code>
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on(
											'click',
											() =>
												void submitAdminAction({
													action: 'remove',
													usernames: [username],
												}),
										),
										css(secondaryButtonCss),
									]}
								>
									{actionState === 'removing' ? 'Removing…' : 'Remove'}
								</button>
							</div>
						))}
					</div>
				</section>
				<section mix={css(cardCss)}>
					<h2
						mix={css({
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							margin: 0,
						})}
					>
						Unreserved built-ins
					</h2>
					<p mix={css(descriptionCss)}>
						Built-in names that operators have explicitly made available.
						Restore puts them back on the reserved list.
					</p>
					{status === 'ready' && removed.length === 0 ? (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No built-in names are currently unreserved.
						</p>
					) : null}
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						{removed.map((username) => (
							<div
								key={username}
								mix={css({
									display: 'flex',
									justifyContent: 'space-between',
									alignItems: 'center',
									gap: spacing.md,
								})}
							>
								<code>{username}</code>
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on(
											'click',
											() =>
												void submitAdminAction({
													action: 'add',
													usernames: [username],
												}),
										),
										css(primaryButtonCss),
									]}
								>
									Restore
								</button>
							</div>
						))}
					</div>
				</section>
				<section mix={css(cardCss)}>
					<h2
						mix={css({
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							margin: 0,
						})}
					>
						Built-in names
					</h2>
					<p mix={css(descriptionCss)}>
						Code-defined denylist. Search to filter. These stay reserved unless
						moved to Unreserved built-ins.
					</p>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Search</span>
						<input
							data-field-ring
							type="search"
							value={builtInQuery}
							placeholder="autodiscover"
							mix={[
								on('input', (event) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) return
									builtInQuery = event.currentTarget.value
									handle.update()
								}),
								css(accountInputCss),
							]}
						/>
					</label>
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						{visibleBuiltIn.length} of {builtIn.length} names
					</p>
					<ul
						mix={css({
							display: 'grid',
							gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
							gap: spacing.sm,
							listStyle: 'none',
							margin: 0,
							padding: 0,
							[mq.tablet]: {
								gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
							},
							[mq.mobile]: {
								gridTemplateColumns: 'minmax(0, 1fr)',
							},
						})}
					>
						{visibleBuiltIn.map((username) => (
							<li key={username}>
								<code>{username}</code>
							</li>
						))}
					</ul>
				</section>
			</AccountManagementShell>
		)
	}
}

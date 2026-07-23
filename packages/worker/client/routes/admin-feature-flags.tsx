import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'
import {
	type AdminFeatureFlag,
	type AdminFeatureFlagsLoaderData,
} from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'
type ActionState =
	| 'idle'
	| 'saving-global'
	| 'saving-override'
	| 'clearing-override'
	| 'deleting-stale'

const adminFeatureFlagsApiPath = '/admin/feature-flags.json'

function isAdminFeatureFlagsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/feature-flags'
}

function summarizeEffectiveSource(flag: AdminFeatureFlag): string {
	if (flag.stale) {
		return 'stale (absent from the code registry)'
	}
	if (!flag.global) {
		return flag.defaultEnabled ? 'default (on)' : 'default (off)'
	}
	if (!flag.global.enabled) {
		return 'globally off'
	}
	if (flag.global.rolloutPercent === null) {
		return 'globally on'
	}
	return `on for ${flag.global.rolloutPercent}% of users`
}

export async function adminFeatureFlagsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminFeatureFlagsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view feature flags.')
	}
	const payload = await readJson<AdminFeatureFlagsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load feature flags.')
	}
	return { adminFeatureFlags: payload }
}

export function AdminFeatureFlagsRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let featureFlags: Array<AdminFeatureFlag> = []
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let actionState: ActionState = 'idle'
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null
	let loadRequestId = 0

	function applyData(payload: AdminFeatureFlagsLoaderData) {
		featureFlags = payload.featureFlags
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	async function loadFeatureFlags() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminFeatureFlagsApiPath, {
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
				message = 'You do not have permission to view feature flags.'
				messageTone = 'error'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminFeatureFlagsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load feature flags.')
			}
			applyData(payload)
			lastLoadedHref = href
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load feature flags.'
			messageTone = 'error'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	async function submitAdminAction(
		body: Record<string, unknown>,
		nextActionState: Exclude<ActionState, 'idle'>,
		successMessage: string,
	): Promise<boolean> {
		actionState = nextActionState
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(adminFeatureFlagsApiPath, {
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
				return false
			}
			const payload = await readJson<
				AdminFeatureFlagsLoaderData & {
					ok?: boolean
					error?: string
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to update feature flags.')
			}
			applyData(payload)
			message = successMessage
			messageTone = 'info'
			return true
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to update feature flags.'
			messageTone = 'error'
			return false
		} finally {
			actionState = 'idle'
			handle.update()
		}
	}

	function handleSaveGlobalSubmit(event: SubmitEvent, key: string) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		const enabled = formData.get('enabled') === 'on'
		const rolloutRaw = String(formData.get('rolloutPercent') ?? '').trim()
		const note = String(formData.get('note') ?? '')
		void submitAdminAction(
			{
				action: 'set_global',
				key,
				enabled,
				rolloutPercent: rolloutRaw === '' ? null : Number(rolloutRaw),
				note,
			},
			'saving-global',
			`Saved global state for ${key}.`,
		)
	}

	function handleAddOverrideSubmit(event: SubmitEvent, key: string) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget
		const formData = new FormData(form)
		const username = String(formData.get('username') ?? '').trim()
		const enabled = String(formData.get('enabled') ?? 'true') === 'true'
		void submitAdminAction(
			{
				action: 'set_user_override',
				key,
				username,
				enabled,
			},
			'saving-override',
			`Saved override for ${username} on ${key}.`,
		).then((ok) => {
			if (ok) form.reset()
		})
	}

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const routeData = isAdminFeatureFlagsPath(currentHref)
			? tryConsumeRouteLoaderData(handle, 'adminFeatureFlags', currentHref)
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
			handle.queueTask(loadFeatureFlags)
		}
		const isMutating = actionState !== 'idle'
		const registryFlags = featureFlags.filter((flag) => !flag.stale)
		const staleFlags = featureFlags.filter((flag) => flag.stale)

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin feature flags"
					description="Toggle registry feature flags, set percentage rollouts, and manage per-user overrides."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading feature flags…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<div mix={css({ display: 'grid', gap: spacing.lg })}>
					{registryFlags.map((flag) => (
						<section
							key={`${flag.key}:${flag.global?.updatedAt ?? 'none'}:${flag.overrides.length}`}
							mix={css(cardCss)}
						>
							<div
								mix={css({
									display: 'grid',
									gap: spacing.sm,
									marginBottom: spacing.md,
								})}
							>
								<div
									mix={css({
										display: 'flex',
										justifyContent: 'space-between',
										gap: spacing.md,
										flexWrap: 'wrap',
										alignItems: 'baseline',
									})}
								>
									<h2
										mix={css({
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											margin: 0,
										})}
									>
										<code mix={css({ fontSize: typography.fontSize.base })}>
											{flag.key}
										</code>
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										{summarizeEffectiveSource(flag)}
									</p>
								</div>
								<p mix={css(descriptionCss)}>
									{flag.description ?? 'No description provided.'}
								</p>
							</div>
							<form
								mix={[
									css({
										display: 'grid',
										gap: spacing.md,
										marginBottom: spacing.lg,
									}),
									on('submit', (event) =>
										handleSaveGlobalSubmit(event, flag.key),
									),
								]}
							>
								<div
									mix={css({
										display: 'grid',
										gridTemplateColumns:
											'auto minmax(0, 8rem) minmax(0, 1fr) auto',
										gap: spacing.md,
										alignItems: 'end',
										[mq.tablet]: {
											gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
										},
										[mq.mobile]: {
											gridTemplateColumns: 'minmax(0, 1fr)',
											alignItems: 'stretch',
										},
									})}
								>
									<label
										mix={css({
											...fieldCss,
											alignContent: 'end',
										})}
									>
										<span mix={css(fieldLabelCss)}>Enabled</span>
										<input
											name="enabled"
											type="checkbox"
											defaultChecked={flag.global?.enabled ?? false}
											disabled={isMutating}
											mix={css({
												width: '1.25rem',
												height: '1.25rem',
												accentColor: colors.primary,
											})}
										/>
									</label>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Rollout %</span>
										<input
											name="rolloutPercent"
											type="number"
											min="0"
											max="100"
											step="1"
											placeholder="All users"
											defaultValue={
												flag.global?.rolloutPercent == null
													? ''
													: String(flag.global.rolloutPercent)
											}
											disabled={isMutating}
											mix={css(inputCss)}
										/>
									</label>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Note</span>
										<input
											name="note"
											type="text"
											placeholder="Optional operator note"
											defaultValue={flag.global?.note ?? ''}
											disabled={isMutating}
											mix={css(inputCss)}
										/>
									</label>
									<button
										type="submit"
										disabled={isMutating}
										mix={css(primaryButtonCss)}
									>
										{actionState === 'saving-global' ? 'Saving…' : 'Save'}
									</button>
								</div>
								{flag.global ? (
									<MetadataGrid
										columns={3}
										items={[
											{
												label: 'Last updated',
												value: formatNullableTimestamp(flag.global.updatedAt),
											},
											{
												label: 'Updated by',
												value:
													flag.global.updatedBy == null
														? 'Unknown'
														: String(flag.global.updatedBy),
											},
											{
												label: 'Note',
												value: flag.global.note || 'None',
											},
										]}
									/>
								) : (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No global row yet — saving creates one. Empty rollout means
										all users when enabled.
									</p>
								)}
							</form>
							<AccountManagementPanel
								title="User overrides"
								description="Per-user overrides win over global state and percentage rollouts."
							>
								{flag.overrides.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No overrides.
									</p>
								) : (
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										{flag.overrides.map((override) => (
											<div
												key={`${flag.key}:${override.userId}`}
												mix={css({
													display: 'flex',
													justifyContent: 'space-between',
													gap: spacing.md,
													flexWrap: 'wrap',
													alignItems: 'center',
													border: `1px solid ${colors.border}`,
													borderRadius: '0.75rem',
													padding: spacing.sm,
												})}
											>
												<div>
													<strong>{override.username}</strong>
													<p
														mix={css({
															margin: 0,
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														{override.enabled ? 'Forced on' : 'Forced off'} ·
														updated{' '}
														{formatNullableTimestamp(override.updatedAt)}
													</p>
												</div>
												<button
													type="button"
													disabled={isMutating}
													mix={[
														on(
															'click',
															() =>
																void submitAdminAction(
																	{
																		action: 'clear_user_override',
																		key: flag.key,
																		userId: override.userId,
																	},
																	'clearing-override',
																	`Removed override for ${override.username}.`,
																),
														),
														css(secondaryButtonCss),
													]}
												>
													{actionState === 'clearing-override'
														? 'Removing…'
														: 'Remove'}
												</button>
											</div>
										))}
									</div>
								)}
								<form
									mix={[
										css({
											display: 'grid',
											gridTemplateColumns:
												'minmax(0, 1fr) minmax(0, 8rem) auto',
											gap: spacing.md,
											alignItems: 'end',
											marginTop: spacing.md,
											[mq.mobile]: {
												gridTemplateColumns: 'minmax(0, 1fr)',
												alignItems: 'stretch',
											},
										}),
										on('submit', (event) =>
											handleAddOverrideSubmit(event, flag.key),
										),
									]}
								>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Username</span>
										<input
											name="username"
											type="text"
											required
											placeholder="username"
											disabled={isMutating}
											mix={css(inputCss)}
										/>
									</label>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>State</span>
										<select
											name="enabled"
											defaultValue="true"
											disabled={isMutating}
											mix={css(inputCss)}
										>
											<option value="true">On</option>
											<option value="false">Off</option>
										</select>
									</label>
									<button
										type="submit"
										disabled={isMutating}
										mix={css(primaryButtonCss)}
									>
										{actionState === 'saving-override'
											? 'Adding…'
											: 'Add override'}
									</button>
								</form>
							</AccountManagementPanel>
						</section>
					))}
				</div>
				{staleFlags.length > 0 ? (
					<section mix={css({ ...cardCss, marginTop: spacing.lg })}>
						<h2
							mix={css({
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								margin: 0,
							})}
						>
							Stale flags
						</h2>
						<p mix={css(descriptionCss)}>
							These keys have database rows but are absent from the code
							registry.
						</p>
						<div mix={css({ display: 'grid', gap: spacing.md })}>
							{staleFlags.map((flag) => (
								<article
									key={flag.key}
									mix={css({
										border: `1px solid ${colors.border}`,
										borderRadius: '0.75rem',
										padding: spacing.md,
										display: 'grid',
										gap: spacing.md,
									})}
								>
									<div
										mix={css({
											display: 'flex',
											justifyContent: 'space-between',
											gap: spacing.md,
											flexWrap: 'wrap',
											alignItems: 'center',
										})}
									>
										<div>
											<code>{flag.key}</code>
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												{summarizeEffectiveSource(flag)}
												{flag.overrides.length > 0
													? ` · ${flag.overrides.length} override(s)`
													: ''}
											</p>
										</div>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on(
													'click',
													() =>
														void submitAdminAction(
															{
																action: 'delete_stale',
																key: flag.key,
															},
															'deleting-stale',
															`Deleted stale flag ${flag.key}.`,
														),
												),
												css(dangerButtonCss),
											]}
										>
											{actionState === 'deleting-stale'
												? 'Deleting…'
												: 'Delete'}
										</button>
									</div>
								</article>
							))}
						</div>
					</section>
				) : null}
			</AccountManagementShell>
		)
	}
}

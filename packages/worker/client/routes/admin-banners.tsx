import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { type AdminBannersLoaderData } from '#universal/loader-data.ts'
import { type SiteBannerRecord } from '#universal/site-banners.ts'
import {
	cardCss,
	descriptionCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { AdminBannerForm } from './admin-banners-form.tsx'
import {
	adminBannersApiPath,
	audienceLabel,
	bannerAfterSave,
	draftFromBanner,
	draftToInput,
	emptyDraft,
	type BannerDraft,
} from './admin-banners-shared.ts'

type PageStatus = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'saving' | 'deleting'

export async function adminBannersRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminBannersApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to manage banners.')
	}
	const payload = await readJson<AdminBannersLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load banners.')
	}
	return { adminBanners: payload }
}

export function AdminBannersRoute(handle: Handle) {
	let banners: Array<SiteBannerRecord> = []
	let draft: BannerDraft = emptyDraft()
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let actionState: ActionState = 'idle'
	/** Payload last applied to the closure state above. */
	let appliedPayload: AdminBannersLoaderData | null = null
	let appliedError: Error | null = null
	const deleteCheck = createDoubleCheck(handle)
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const bannersData = createRouteData({
		key: 'adminBanners',
		async load(_href, signal) {
			const response = await fetch(adminBannersApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			if (response.status === 403) {
				throw new Error('You do not have permission to manage banners.')
			}
			const payload = await readJson<AdminBannersLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load banners.')
			}
			return payload
		},
	})

	function applyData(payload: AdminBannersLoaderData) {
		banners = payload.banners
		message = null
		messageTone = 'info'
		if (draft.id && !payload.banners.some((banner) => banner.id === draft.id)) {
			draft = emptyDraft()
		}
	}

	async function submitAdminAction(
		body: Record<string, unknown>,
		nextActionState: Exclude<ActionState, 'idle'>,
		successMessage: string,
	): Promise<AdminBannersLoaderData | null> {
		actionState = nextActionState
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(adminBannersApiPath, {
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
				return null
			}
			const payload = await readJson<
				AdminBannersLoaderData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to update banners.')
			}
			applyData(payload)
			message = successMessage
			messageTone = 'info'
			return payload
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to update banners.'
			messageTone = 'error'
			return null
		} finally {
			actionState = 'idle'
			handle.update()
		}
	}

	function handleSaveSubmit(event: SubmitEvent) {
		event.preventDefault()
		const wasCreate = draft.id === null
		void submitAdminAction(
			{ action: 'save', ...draftToInput(draft) },
			'saving',
			wasCreate ? 'Banner created.' : 'Banner saved.',
		).then((payload) => {
			if (!payload || !wasCreate) return
			const created = bannerAfterSave(banners, payload.savedBannerId)
			if (created) draft = draftFromBanner(created)
			handle.update()
		})
	}

	function handleDelete() {
		if (!draft.id) return
		void submitAdminAction(
			{ action: 'delete', id: draft.id },
			'deleting',
			'Banner deleted.',
		).then((ok) => {
			if (ok) draft = emptyDraft()
			handle.update()
		})
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = bannersData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyData(snapshot.data)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
			messageTone = 'error'
		}
		const pending = snapshot.kind === 'pending'
		const status: PageStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AdminPageHeader
					title="Admin banners"
					description="Create, target, and enable site announcement banners. Edit the strip itself before you save. Content is live without a deploy."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading banners…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<AdminBannerForm
					draft={draft}
					updatedAt={
						banners.find((banner) => banner.id === draft.id)?.updatedAt ?? null
					}
					isMutating={actionState !== 'idle'}
					actionState={actionState}
					deleteCheck={deleteCheck}
					onDraftChange={(next) => {
						draft = next
						handle.update()
					}}
					onSave={handleSaveSubmit}
					onDelete={handleDelete}
				>
					<section mix={css(cardCss)}>
						<div
							mix={css({
								display: 'flex',
								justifyContent: 'space-between',
								gap: spacing.sm,
								alignItems: 'center',
								marginBottom: spacing.md,
							})}
						>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
								})}
							>
								Banners
							</h2>
							<button
								type="button"
								mix={[
									css(secondaryButtonCss),
									on('click', () => {
										draft = emptyDraft()
										handle.update()
									}),
								]}
							>
								New
							</button>
						</div>
						{banners.length === 0 ? (
							<p mix={css({ ...descriptionCss, margin: 0 })}>
								No banners yet. Create one to announce the launch video.
							</p>
						) : (
							<ul
								mix={css({
									listStyle: 'none',
									margin: 0,
									padding: 0,
									display: 'grid',
									gap: spacing.sm,
								})}
							>
								{banners.map((banner) => (
									<li key={banner.id}>
										<button
											type="button"
											mix={[
												css({
													width: '100%',
													textAlign: 'left',
													padding: spacing.sm,
													borderRadius: '0.75rem',
													border: `1px solid ${
														draft.id === banner.id
															? colors.primary
															: colors.border
													}`,
													backgroundColor:
														draft.id === banner.id
															? colors.primarySoftest
															: colors.surface,
													cursor: 'pointer',
												}),
												on('click', () => {
													draft = draftFromBanner(banner)
													handle.update()
												}),
											]}
										>
											<strong
												mix={css({
													display: 'block',
													fontSize: typography.fontSize.sm,
												})}
											>
												{banner.title}
											</strong>
											<span
												mix={css({
													color: colors.textMuted,
													fontSize: typography.fontSize.xs,
												})}
											>
												{banner.enabled ? 'Enabled' : 'Disabled'} · p
												{banner.priority} · {banner.look} ·{' '}
												{audienceLabel(banner.audience)}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</section>
				</AdminBannerForm>
			</AccountManagementShell>
		)
	}
}

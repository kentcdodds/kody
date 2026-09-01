import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { type Handle, css, ref } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	adminProviderMarksApiPath,
	filterMarks,
	groupMarks,
	isAdminProviderMarksPath,
	markGroupKey,
	splitAliasInput,
} from '#client/routes/admin-provider-marks-shared.ts'
import {
	accountInputCss,
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { RecordTableSearch } from './record-table.tsx'
import {
	type AdminProviderMark,
	type AdminProviderMarksLoaderData,
	type AppLoaderData,
} from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
	hoverMq,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'

type PageStatus = 'loading' | 'ready' | 'error'
type ActionState = 'idle' | 'saving' | 'deleting'

const markGroupCss = {
	...nativeDisclosureCss,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	padding: spacing.sm,
	'& > summary': {
		...nativeDisclosureCss['& > summary'],
		width: '100%',
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: spacing.sm,
		fontVariantNumeric: 'tabular-nums',
	},
	'&[open] > summary': { marginBottom: spacing.sm },
}

const markGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))',
	gap: '0.25rem',
}

const markTileCss = {
	display: 'grid',
	placeItems: 'center',
	aspectRatio: '1 / 1',
	padding: '0.2rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.sm,
	background: 'transparent',
	color: 'inherit',
	cursor: 'pointer',
	minWidth: 0,
	'&[data-selected]': {
		borderColor: colors.primary,
		backgroundColor: colors.primarySoftest,
	},
	[hoverMq]: {
		'&:not([data-selected]):hover': { backgroundColor: colors.background },
	},
}

export function AdminProviderMarksRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let marks: Array<AdminProviderMark> = []
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let actionState: ActionState = 'idle'
	let search = ''
	let selectedSlug: string | null = null
	let creating = false
	let lastLoadedHref = ''
	let loadingHref: string | null = null
	let lastFailedHref: string | null = null
	let loadRequestId = 0
	let pendingLogoBase64: string | undefined = undefined
	let logoReadRevision = 0
	let removeLogoChecked = false
	let formRevision = 0
	const openGroups = new Set<string>()
	const deleteCheck = createDoubleCheck(handle)

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const ghostButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function applyData(payload: AdminProviderMarksLoaderData) {
		marks = payload.marks
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	function resetFormState() {
		pendingLogoBase64 = undefined
		removeLogoChecked = false
		deleteCheck.reset()
	}

	function selectMark(slug: string | null) {
		creating = false
		selectedSlug = slug
		if (slug) openGroups.add(markGroupKey(slug))
		resetFormState()
		formRevision += 1
	}

	async function loadMarks() {
		const href = readCurrentRouterHref(handle)
		loadingHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminProviderMarksApiPath, {
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
				message = 'You do not have permission to view provider marks.'
				messageTone = 'error'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminProviderMarksLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load provider marks.')
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
					: 'Unable to load provider marks.'
			messageTone = 'error'
			lastFailedHref = href
			handle.update()
		} finally {
			if (loadingHref === href) loadingHref = null
		}
	}

	function handleLogoFileChange(event: Event) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement)) return
		const file = input.files?.[0]
		if (!file) {
			logoReadRevision += 1
			pendingLogoBase64 = undefined
			handle.update()
			return
		}
		removeLogoChecked = false
		const revision = ++logoReadRevision
		const reader = new FileReader()
		reader.onload = () => {
			if (revision !== logoReadRevision) return
			if (typeof reader.result !== 'string') return
			const commaIndex = reader.result.indexOf(',')
			pendingLogoBase64 =
				commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result
			handle.update()
		}
		reader.readAsDataURL(file)
	}

	async function submitAction(
		body: Record<string, unknown>,
		nextState: ActionState,
		successMessage: string,
	) {
		if (actionState !== 'idle') return false
		actionState = nextState
		message = null
		handle.update()
		try {
			const response = await fetch(adminProviderMarksApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(body),
			})
			const payload = await readJson<
				AdminProviderMarksLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save provider mark.')
			}
			applyData(payload)
			message = successMessage
			messageTone = 'info'
			resetFormState()
			return true
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to save provider mark.'
			messageTone = 'error'
			return false
		} finally {
			actionState = 'idle'
			handle.update()
		}
	}

	function handleSaveFormSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		const slug = String(formData.get('slug') ?? '').trim()
		const label = String(formData.get('label') ?? '').trim()
		const aliases = splitAliasInput(String(formData.get('aliases') ?? ''))
		if (!slug) {
			message = 'Slug is required.'
			messageTone = 'error'
			handle.update()
			return
		}
		const body: Record<string, unknown> = {
			action: 'save',
			slug,
			label,
			aliases,
		}
		if (removeLogoChecked) {
			body.logoBase64 = ''
		} else if (pendingLogoBase64 !== undefined) {
			body.logoBase64 = pendingLogoBase64
		}
		void submitAction(body, 'saving', `Saved provider mark ${slug}.`).then(
			(ok) => {
				if (!ok) return
				creating = false
				const canonicalSlug = normalizeProviderKey(slug)
				selectedSlug =
					marks.find((item) => item.slug === canonicalSlug)?.slug ??
					marks.find((item) => item.slug === slug)?.slug ??
					null
				if (selectedSlug) openGroups.add(markGroupKey(selectedSlug))
				formRevision += 1
				handle.update()
			},
		)
	}

	function handleDelete(mark: AdminProviderMark) {
		void submitAction(
			{ action: 'delete', slug: mark.slug },
			'deleting',
			`Deleted provider mark ${mark.slug}.`,
		).then((ok) => {
			if (!ok) return
			creating = false
			selectedSlug = null
			formRevision += 1
			handle.update()
		})
	}

	function renderMarkGlyph(
		mark: Pick<AdminProviderMark, 'label' | 'logoPath'>,
	) {
		return (
			<span mix={css(getLogoWellCss({ size: '1.75rem', radius: '0' }))}>
				{mark.logoPath ? (
					<img
						src={mark.logoPath}
						alt=""
						width={20}
						height={20}
						mix={css({
							display: 'block',
							width: '70%',
							height: '70%',
							objectFit: 'contain',
						})}
					/>
				) : (
					mark.label.trim().charAt(0).toUpperCase() || '?'
				)}
			</span>
		)
	}

	function renderEditor(editingMark: AdminProviderMark | null) {
		const isMutating = actionState !== 'idle'
		return (
			<form
				key={formRevision}
				data-testid="provider-mark-editor"
				mix={[
					css({
						display: 'grid',
						gap: spacing.md,
						borderBottom: `1px solid ${colors.border}`,
						paddingBottom: spacing.md,
					}),
					on('submit', handleSaveFormSubmit),
					ref((node) => {
						node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
					}),
				]}
			>
				<h2 mix={css({ margin: 0, fontSize: typography.fontSize.lg })}>
					{editingMark ? `Edit ${editingMark.slug}` : 'New provider mark'}
				</h2>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Slug</span>
					<input
						data-field-ring
						name="slug"
						required
						disabled={isMutating || editingMark != null}
						defaultValue={editingMark?.slug ?? ''}
						placeholder="google"
						mix={css(accountInputCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Label</span>
					<input
						data-field-ring
						name="label"
						disabled={isMutating}
						defaultValue={editingMark?.label ?? ''}
						placeholder="Google"
						mix={css(accountInputCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>
						Aliases (provider keys and authorize hosts)
					</span>
					<input
						data-field-ring
						name="aliases"
						disabled={isMutating}
						defaultValue={editingMark?.aliases.join(', ') ?? ''}
						placeholder="accounts.google.com, googleapis.com"
						mix={css(accountInputCss)}
					/>
					<span
						mix={css({
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						})}
					>
						Also matches this slug as a host label, built-in keys for known
						providers, and family keys like {editingMark?.slug ?? 'slug'}-*.
					</span>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Logo</span>
					<input
						data-field-ring
						name="logo"
						type="file"
						accept="image/svg+xml,image/png,image/jpeg,image/webp"
						disabled={isMutating}
						mix={[on('change', handleLogoFileChange), css(accountInputCss)]}
					/>
				</label>
				{editingMark?.logoPath ? (
					<label
						mix={css({
							...fieldCss,
							display: 'flex',
							flexDirection: 'row',
							alignItems: 'center',
							gap: spacing.sm,
						})}
					>
						<img src={editingMark.logoPath} alt="" width={32} height={32} />
						<input
							name="removeLogo"
							type="checkbox"
							checked={removeLogoChecked}
							disabled={isMutating}
							mix={on('change', (event) => {
								const checkbox = event.currentTarget
								if (!(checkbox instanceof HTMLInputElement)) return
								removeLogoChecked = checkbox.checked
								handle.update()
							})}
						/>
						<span mix={css(fieldLabelCss)}>Remove logo</span>
					</label>
				) : null}
				<div
					mix={css({
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
					})}
				>
					<button
						type="submit"
						disabled={isMutating}
						mix={css(primaryButtonCss)}
					>
						{actionState === 'saving' ? 'Saving…' : 'Save mark'}
					</button>
					<button
						type="button"
						disabled={isMutating}
						mix={[
							css(ghostButtonCss),
							on('click', () => {
								creating = false
								selectedSlug = null
								resetFormState()
								handle.update()
							}),
						]}
					>
						Cancel
					</button>
					{editingMark ? (
						<button
							type="button"
							disabled={isMutating}
							mix={[
								css(dangerButtonCss),
								...deleteCheck.getButtonMix({
									on: {
										click: () => handleDelete(editingMark),
									},
								}),
							]}
						>
							{deleteCheck.doubleCheck
								? 'Click again to delete'
								: actionState === 'deleting'
									? 'Deleting…'
									: 'Delete'}
						</button>
					) : null}
				</div>
			</form>
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const routeData = isAdminProviderMarksPath(currentHref)
			? (tryConsumeRouteLoaderData(
					handle,
					'adminProviderMarks' as keyof AppLoaderData,
					currentHref,
				) as AdminProviderMarksLoaderData | undefined)
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
			loadingHref !== currentHref
		if (!routeData && needsLoad && typeof document !== 'undefined') {
			if (lastLoadedHref === '') status = 'loading'
			handle.queueTask(loadMarks)
		}

		const filteredMarks = filterMarks(marks, search)
		const groups = groupMarks(filteredMarks)
		const searchActive = search.trim().length > 0
		const editingMark = creating
			? null
			: (marks.find((item) => item.slug === selectedSlug) ?? null)
		const isMutating = actionState !== 'idle'

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin provider marks"
					description="Operator-owned brand marks for saved integrations. Open a letter, pick a mark, and edit it in that group. Login and onboarding keep their inline icons."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{status === 'loading' && lastLoadedHref === '' ? (
					<p>Loading provider marks…</p>
				) : null}
				<RecordTableSearch
					label="Filter marks"
					placeholder="Filter marks"
					value={search}
					onInput={(value) => {
						search = value
						handle.update()
					}}
				/>
				<p
					mix={css({
						margin: 0,
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
						fontVariantNumeric: 'tabular-nums',
					})}
				>
					{searchActive
						? `${filteredMarks.length} match${filteredMarks.length === 1 ? '' : 'es'} of ${marks.length} marks`
						: `${marks.length} marks`}
				</p>
				<details
					open={creating ? true : undefined}
					data-testid="add-mark"
					mix={[
						css(markGroupCss),
						on('toggle', (event) => {
							if (!(event.currentTarget instanceof HTMLDetailsElement)) return
							if (event.currentTarget.open) {
								selectMark(null)
								creating = true
							} else if (creating) {
								creating = false
								resetFormState()
							}
							handle.update()
						}),
					]}
				>
					<summary>Add mark</summary>
					{creating ? renderEditor(null) : null}
				</details>
				{status === 'ready' && filteredMarks.length === 0 ? (
					<p mix={css({ color: colors.textMuted })}>No provider marks yet.</p>
				) : (
					<div
						data-testid="provider-mark-groups"
						mix={css({
							display: 'grid',
							gap: spacing.sm,
						})}
					>
						{groups.map((group) => {
							const groupOpen = searchActive || openGroups.has(group.key)
							const groupEditing =
								editingMark != null &&
								markGroupKey(editingMark.slug) === group.key
							return (
								<details
									key={group.key}
									open={groupOpen ? true : undefined}
									data-testid={`mark-group-${group.key}`}
									mix={[
										css(markGroupCss),
										on('toggle', (event) => {
											if (
												!(event.currentTarget instanceof HTMLDetailsElement)
											) {
												return
											}
											if (event.currentTarget.open) {
												openGroups.add(group.key)
											} else {
												openGroups.delete(group.key)
												if (
													selectedSlug &&
													markGroupKey(selectedSlug) === group.key
												) {
													selectMark(null)
												}
											}
											handle.update()
										}),
									]}
								>
									<summary>
										<span>{group.key}</span>
										<span mix={css({ color: colors.textMuted })}>
											{group.marks.length}
										</span>
									</summary>
									{groupOpen ? (
										<div mix={css({ display: 'grid', gap: spacing.md })}>
											{groupEditing && editingMark
												? renderEditor(editingMark)
												: null}
											<div mix={css(markGridCss)}>
												{group.marks.map((item) => (
													<button
														key={item.slug}
														type="button"
														title={`${item.label} (${item.slug})`}
														aria-label={`${item.label} (${item.slug})`}
														aria-pressed={
															selectedSlug === item.slug && !creating
																? 'true'
																: 'false'
														}
														data-testid={`mark-tile-${item.slug}`}
														data-selected={
															selectedSlug === item.slug && !creating
																? 'true'
																: undefined
														}
														disabled={isMutating}
														mix={[
															css(markTileCss),
															on('click', () => {
																if (isMutating) return
																if (selectedSlug === item.slug && !creating) {
																	selectMark(null)
																} else {
																	selectMark(item.slug)
																}
																handle.update()
															}),
														]}
													>
														{renderMarkGlyph(item)}
													</button>
												))}
											</div>
										</div>
									) : null}
								</details>
							)
						})}
					</div>
				)}
			</AccountManagementShell>
		)
	}
}

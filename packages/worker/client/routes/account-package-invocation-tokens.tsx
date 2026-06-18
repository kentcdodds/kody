import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	inputCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'

type PackageOption = {
	id: string
	kodyId: string
	name: string
}

type PackageInvocationTokenListItem = {
	id: string
	name: string
	packageIds: Array<string>
	packageKodyIds: Array<string>
	exportNames: Array<string>
	sources: Array<string>
	createdAt: string
	updatedAt: string
	lastUsedAt: string | null
	revokedAt: string | null
}

type AccountPackageInvocationTokensPayload = {
	ok: true
	email: string
	username: string
	invocationUrlOrigin: string
	packages: Array<PackageOption>
	tokens: Array<PackageInvocationTokenListItem>
	selectedTokenId?: string
}

type EditorState = {
	name: string
	rawToken: string
	packageIdsText: string
	packageKodyIdsText: string
	exportNamesText: string
	sourcesText: string
}

const accountPackageInvocationTokensApiPath =
	'/account/package-invocation-tokens.json'
const accountPackageInvocationTokensBasePath =
	'/account/package-invocation-tokens'
const wildcardScope = '*'

function createEmptyEditorState(): EditorState {
	return {
		name: '',
		rawToken: '',
		packageIdsText: '',
		packageKodyIdsText: '',
		exportNamesText: '',
		sourcesText: '',
	}
}

function formatTimestamp(value: string | null) {
	return value ? new Date(value).toLocaleString() : 'Never'
}

function readTrimmedParam(params: URLSearchParams, key: string) {
	const value = params.get(key)
	return value?.trim() ? value.trim() : null
}

function readCommaListParams(params: URLSearchParams, keys: Array<string>) {
	return keys.flatMap((key) =>
		params
			.getAll(key)
			.flatMap((value) => value.split(','))
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
	)
}

function createEditorStateFromNewTokenQuery(href: string): EditorState {
	const params = new URL(href, 'http://localhost').searchParams
	const state = createEmptyEditorState()
	const packageIds = readCommaListParams(params, ['packageId', 'packageIds'])
	const packageKodyIds = readCommaListParams(params, [
		'packageKodyId',
		'packageKodyIds',
		'kodyId',
		'kodyIds',
	])
	const exportNames = readCommaListParams(params, ['exportName', 'exportNames'])
	const sources = readCommaListParams(params, ['source', 'sources'])
	return {
		...state,
		name: readTrimmedParam(params, 'name') ?? state.name,
		packageIdsText: packageIds.join('\n'),
		packageKodyIdsText: packageKodyIds.join('\n'),
		exportNamesText: exportNames.join('\n'),
		sourcesText: sources.join('\n'),
	}
}

function isNewTokenPath(href: string) {
	const url = new URL(href, 'http://localhost')
	return url.pathname === `${accountPackageInvocationTokensBasePath}/new`
}

function getNewTokenQueryKey(href: string) {
	const url = new URL(href, 'http://localhost')
	if (url.pathname !== `${accountPackageInvocationTokensBasePath}/new`)
		return ''
	const keys = [
		'name',
		'packageId',
		'packageIds',
		'packageKodyId',
		'packageKodyIds',
		'kodyId',
		'kodyIds',
		'exportName',
		'exportNames',
		'source',
		'sources',
	]
	return keys
		.map((key) => `${key}=${url.searchParams.getAll(key).join('\u0000')}`)
		.join('&')
}

function parseListText(value: string) {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

function formatScope(values: Array<string>) {
	if (values.length === 0) return 'None'
	if (values.includes(wildcardScope)) return 'Any'
	return values.join(', ')
}

function tokenStatus(token: PackageInvocationTokenListItem) {
	return token.revokedAt ? 'Revoked' : 'Active'
}

function tokenStatusCss(token: PackageInvocationTokenListItem) {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		width: 'max-content',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.full,
		fontSize: typography.fontSize.sm,
		fontWeight: typography.fontWeight.medium,
		backgroundColor: token.revokedAt
			? 'color-mix(in srgb, var(--color-danger) 8%, transparent)'
			: colors.primarySoftest,
		color: token.revokedAt ? colors.error : colors.primaryText,
	}
}

export function AccountPackageInvocationTokensRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveState: 'idle' | 'creating' | 'revoking' = 'idle'
	let email = ''
	let username = ''
	let invocationUrlOrigin = ''
	let packages: Array<PackageOption> = []
	let tokens: Array<PackageInvocationTokenListItem> = []
	let editorState = createEmptyEditorState()
	let selectedTokenId: string | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let lastLoadedHref = ''
	let lastNewTokenQueryKey = ''
	let mutationVersion = 0
	let revokeConfirm = false

	const primaryButtonCss = getPrimaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	function redirectToLogin() {
		saveState = 'idle'
		status = 'ready'
		if (typeof window !== 'undefined') {
			window.location.assign('/login')
		}
	}

	async function loadTokens(signal: AbortSignal) {
		const loadStartedAtMutationVersion = mutationVersion
		try {
			const href =
				typeof window === 'undefined'
					? accountPackageInvocationTokensBasePath
					: window.location.href
			lastLoadedHref = href
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload =
				await readJson<AccountPackageInvocationTokensPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load package invocation tokens.')
			}
			if (loadStartedAtMutationVersion !== mutationVersion) return
			const latestHref =
				typeof window === 'undefined'
					? accountPackageInvocationTokensBasePath
					: window.location.href
			if (href !== latestHref) return
			applyPayload(payload, latestHref)
			status = 'ready'
			message = null
			messageTone = 'info'
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			if (loadStartedAtMutationVersion !== mutationVersion) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load package invocation tokens.'
			messageTone = 'error'
			handle.update()
		}
	}

	function applyPayload(
		payload: AccountPackageInvocationTokensPayload,
		href: string,
	) {
		email = payload.email
		username = payload.username
		invocationUrlOrigin = payload.invocationUrlOrigin
		packages = payload.packages
		tokens = payload.tokens
		revokeConfirm = false
		if (payload.selectedTokenId) {
			selectedTokenId = payload.selectedTokenId
			editorState = createEmptyEditorState()
			lastNewTokenQueryKey = ''
			return
		}
		if (isNewTokenPath(href)) {
			const queryKey = getNewTokenQueryKey(href)
			if (queryKey !== lastNewTokenQueryKey) {
				lastNewTokenQueryKey = queryKey
				editorState = createEditorStateFromNewTokenQuery(href)
				selectedTokenId = null
			}
			return
		}
		editorState = createEmptyEditorState()
		lastNewTokenQueryKey = ''
		if (
			selectedTokenId &&
			!tokens.some((token) => token.id === selectedTokenId)
		) {
			selectedTokenId = null
		}
	}

	function setEditorField(field: keyof EditorState, value: string) {
		editorState = {
			...editorState,
			[field]: value,
		}
	}

	function readEditorStateFromForm(form: HTMLFormElement) {
		const formData = new FormData(form)
		return {
			name: String(formData.get('name') ?? '').trim(),
			rawToken: String(formData.get('rawToken') ?? '').trim(),
			packageIdsText: String(formData.get('packageIds') ?? ''),
			packageKodyIdsText: String(formData.get('packageKodyIds') ?? ''),
			exportNamesText: String(formData.get('exportNames') ?? ''),
			sourcesText: String(formData.get('sources') ?? ''),
		} satisfies EditorState
	}

	function startNewToken() {
		editorState = createEmptyEditorState()
		selectedTokenId = null
		revokeConfirm = false
		message = null
		messageTone = 'info'
		if (typeof window !== 'undefined') {
			window.history.pushState(
				null,
				'',
				`${accountPackageInvocationTokensBasePath}/new`,
			)
			lastLoadedHref = window.location.href
			lastNewTokenQueryKey = getNewTokenQueryKey(window.location.href)
		}
		handle.update()
	}

	async function createToken(form?: HTMLFormElement) {
		if (saveState !== 'idle') return
		const nextEditorState = form ? readEditorStateFromForm(form) : editorState
		editorState = nextEditorState
		const packageIds = parseListText(nextEditorState.packageIdsText)
		const packageKodyIds = parseListText(nextEditorState.packageKodyIdsText)
		const exportNames = parseListText(nextEditorState.exportNamesText)
		const sources = parseListText(nextEditorState.sourcesText)

		if (!nextEditorState.name) {
			message = 'Token name is required.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (!nextEditorState.rawToken) {
			message = 'Paste the raw token before creating it.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (packageIds.length === 0 && packageKodyIds.length === 0) {
			message =
				'Add at least one package id, Kody id, or wildcard package scope.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (exportNames.length === 0) {
			message = 'Add at least one export name or wildcard export scope.'
			messageTone = 'error'
			handle.update()
			return
		}

		saveState = 'creating'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'create',
					name: nextEditorState.name,
					rawToken: nextEditorState.rawToken,
					packageIds,
					packageKodyIds,
					exportNames,
					sources,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to create token.')
			}
			mutationVersion += 1
			applyPayload(payload, accountPackageInvocationTokensBasePath)
			saveState = 'idle'
			editorState = createEmptyEditorState()
			message =
				'Created token. The raw token was not stored and will not be shown again.'
			messageTone = 'info'
			if (typeof window !== 'undefined') {
				window.history.pushState(
					null,
					'',
					accountPackageInvocationTokensBasePath,
				)
				lastLoadedHref = window.location.href
			}
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to create token.'
			messageTone = 'error'
			handle.update()
		}
	}

	async function revokeSelectedToken() {
		if (!selectedTokenId || saveState !== 'idle') return
		saveState = 'revoking'
		message = null
		messageTone = 'info'
		handle.update()
		try {
			const response = await fetch(accountPackageInvocationTokensApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'revoke',
					id: selectedTokenId,
				}),
			})
			if (response.status === 401) {
				redirectToLogin()
				return
			}
			const payload = await readJson<
				AccountPackageInvocationTokensPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke token.')
			}
			mutationVersion += 1
			applyPayload(payload, accountPackageInvocationTokensBasePath)
			saveState = 'idle'
			message = 'Revoked token.'
			messageTone = 'info'
			handle.update()
		} catch (error) {
			saveState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to revoke token.'
			messageTone = 'error'
			handle.update()
		}
	}

	function selectToken(token: PackageInvocationTokenListItem) {
		selectedTokenId = token.id
		editorState = createEmptyEditorState()
		lastNewTokenQueryKey = ''
		revokeConfirm = false
		message = null
		messageTone = 'info'
		if (typeof window !== 'undefined') {
			window.history.pushState(null, '', accountPackageInvocationTokensBasePath)
			lastLoadedHref = window.location.href
		}
		handle.update()
	}

	return () => {
		const currentHref =
			typeof window === 'undefined'
				? accountPackageInvocationTokensBasePath
				: window.location.href
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (status === 'loading' || isRefreshingForLocationChange) {
			handle.queueTask(loadTokens)
		}
		const isMutating = saveState !== 'idle'
		const selectedToken =
			tokens.find((token) => token.id === selectedTokenId) ?? null
		const endpointTemplate = username
			? `${invocationUrlOrigin}/@${username}/api/package-invocations/<kodyId>/<exportName>`
			: ''

		return (
			<section
				mix={css({
					maxWidth: '76rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.xl,
				})}
			>
				<header
					mix={css({
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'flex-start',
						gap: spacing.md,
						flexWrap: 'wrap',
					})}
				>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<h1
							mix={css({
								fontSize: typography.fontSize.xl,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
								margin: 0,
							})}
						>
							{email
								? `${email} package invocation tokens`
								: 'Package invocation tokens'}
						</h1>
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							Create bearer tokens for trusted personal clients without storing
							the raw token in Kody.
						</p>
					</div>
					<button
						type="button"
						disabled={isMutating}
						mix={[on('click', startNewToken), css(primaryButtonCss)]}
					>
						New token
					</button>
				</header>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading package invocation tokens...
					</p>
				) : null}
				{message ? (
					<p
						role="alert"
						mix={css({
							color: messageTone === 'error' ? colors.error : colors.text,
							margin: 0,
						})}
					>
						{message}
					</p>
				) : null}

				{status === 'ready' ? (
					<section
						mix={css({
							display: 'grid',
							gridTemplateColumns: 'minmax(18rem, 24rem) minmax(0, 1fr)',
							gap: spacing.lg,
							alignItems: 'start',
							[mq.mobile]: {
								gridTemplateColumns: '1fr',
							},
						})}
					>
						<aside mix={css(cardCss)}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<h2 mix={css(cardTitleCss)}>Tokens</h2>
								<p mix={css(descriptionCss)}>
									Revoked tokens remain listed for auditability and no longer
									authorize external invocation requests.
								</p>
							</div>
							{tokens.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No package invocation tokens yet.
								</p>
							) : (
								<ul
									mix={css({
										listStyle: 'none',
										padding: 0,
										margin: 0,
										display: 'grid',
										gap: spacing.sm,
									})}
								>
									{tokens.map((token) => {
										const isSelected = selectedTokenId === token.id
										return (
											<li key={token.id}>
												<button
													type="button"
													mix={[
														on('click', () => selectToken(token)),
														css({
															width: '100%',
															display: 'grid',
															gap: spacing.xs,
															textAlign: 'left',
															padding: spacing.md,
															borderRadius: radius.md,
															border: `1px solid ${
																isSelected ? colors.primary : colors.border
															}`,
															backgroundColor: isSelected
																? colors.primarySoftest
																: colors.background,
															color: colors.text,
															cursor: 'pointer',
														}),
													]}
												>
													<strong>{token.name}</strong>
													<span mix={css(tokenStatusCss(token))}>
														{tokenStatus(token)}
													</span>
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														Exports: {formatScope(token.exportNames)}
													</span>
												</button>
											</li>
										)
									})}
								</ul>
							)}
						</aside>

						<div mix={css({ display: 'grid', gap: spacing.lg })}>
							<form
								method="post"
								noValidate
								mix={[
									on('submit', (event) => {
										event.preventDefault()
										if (event.currentTarget instanceof HTMLFormElement) {
											void createToken(event.currentTarget)
										}
									}),
									css(cardCss),
								]}
							>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2 mix={css(cardTitleCss)}>Create token</h2>
									<p mix={css(descriptionCss)}>
										Paste the raw token once. Kody stores only its hash, so keep
										the raw value in the trusted client.
									</p>
								</div>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Name</span>
									<input
										name="name"
										type="text"
										value={editorState.name}
										placeholder="Personal automation"
										disabled={isMutating}
										required
										mix={[
											on('input', (event) => {
												setEditorField('name', event.currentTarget.value)
												handle.update()
											}),
											css(inputCss),
										]}
									/>
								</label>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Raw token</span>
									<input
										name="rawToken"
										type="password"
										value={editorState.rawToken}
										placeholder="Paste the locally generated token"
										autoComplete="off"
										disabled={isMutating}
										required
										mix={[
											on('input', (event) => {
												setEditorField('rawToken', event.currentTarget.value)
												handle.update()
											}),
											css(inputCss),
										]}
									/>
								</label>

								<div
									mix={css({
										display: 'grid',
										gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
										gap: spacing.md,
										[mq.mobile]: {
											gridTemplateColumns: '1fr',
										},
									})}
								>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Package Kody IDs</span>
										<textarea
											name="packageKodyIds"
											value={editorState.packageKodyIdsText}
											placeholder={'discord-gateway\n*'}
											disabled={isMutating}
											mix={[
												on('input', (event) => {
													setEditorField(
														'packageKodyIdsText',
														event.currentTarget.value,
													)
													handle.update()
												}),
												css(textareaCss),
											]}
										/>
									</label>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Package IDs</span>
										<textarea
											name="packageIds"
											value={editorState.packageIdsText}
											placeholder="pkg_..."
											disabled={isMutating}
											mix={[
												on('input', (event) => {
													setEditorField(
														'packageIdsText',
														event.currentTarget.value,
													)
													handle.update()
												}),
												css(textareaCss),
											]}
										/>
									</label>
								</div>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Export names</span>
									<textarea
										name="exportNames"
										value={editorState.exportNamesText}
										placeholder={'dispatch-message-created\n*'}
										disabled={isMutating}
										required
										mix={[
											on('input', (event) => {
												setEditorField(
													'exportNamesText',
													event.currentTarget.value,
												)
												handle.update()
											}),
											css(textareaCss),
										]}
									/>
								</label>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Allowed sources</span>
									<textarea
										name="sources"
										value={editorState.sourcesText}
										placeholder="personal-client"
										disabled={isMutating}
										mix={[
											on('input', (event) => {
												setEditorField('sourcesText', event.currentTarget.value)
												handle.update()
											}),
											css(textareaCss),
										]}
									/>
									<span mix={css(descriptionCss)}>
										Leave blank to allow requests that omit source. If a request
										supplies source, it must be listed here exactly.
									</span>
								</label>

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
										{saveState === 'creating' ? 'Creating...' : 'Create token'}
									</button>
								</div>
							</form>

							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>Invocation endpoint</h2>
								<p mix={css(descriptionCss)}>
									External clients call this endpoint with the raw token in the
									Authorization header.
								</p>
								<code
									mix={css({
										display: 'block',
										padding: spacing.sm,
										borderRadius: radius.md,
										border: `1px solid ${colors.border}`,
										backgroundColor: colors.background,
										color: colors.text,
										fontFamily: 'monospace',
										fontSize: typography.fontSize.sm,
										overflowWrap: 'anywhere',
									})}
								>
									{endpointTemplate}
								</code>
							</section>

							{selectedToken ? (
								<section mix={css(cardCss)}>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>{selectedToken.name}</h2>
										<span mix={css(tokenStatusCss(selectedToken))}>
											{tokenStatus(selectedToken)}
										</span>
									</div>
									<dl
										mix={css({
											display: 'grid',
											gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
											gap: spacing.md,
											margin: 0,
											[mq.mobile]: {
												gridTemplateColumns: '1fr',
											},
										})}
									>
										<div>
											<dt mix={css(fieldLabelCss)}>Packages</dt>
											<dd mix={css({ margin: 0, color: colors.text })}>
												{formatScope([
													...selectedToken.packageKodyIds,
													...selectedToken.packageIds,
												])}
											</dd>
										</div>
										<div>
											<dt mix={css(fieldLabelCss)}>Exports</dt>
											<dd mix={css({ margin: 0, color: colors.text })}>
												{formatScope(selectedToken.exportNames)}
											</dd>
										</div>
										<div>
											<dt mix={css(fieldLabelCss)}>Sources</dt>
											<dd mix={css({ margin: 0, color: colors.text })}>
												{formatScope(selectedToken.sources)}
											</dd>
										</div>
										<div>
											<dt mix={css(fieldLabelCss)}>Last used</dt>
											<dd mix={css({ margin: 0, color: colors.text })}>
												{formatTimestamp(selectedToken.lastUsedAt)}
											</dd>
										</div>
										<div>
											<dt mix={css(fieldLabelCss)}>Created</dt>
											<dd mix={css({ margin: 0, color: colors.text })}>
												{formatTimestamp(selectedToken.createdAt)}
											</dd>
										</div>
										<div>
											<dt mix={css(fieldLabelCss)}>Revoked</dt>
											<dd mix={css({ margin: 0, color: colors.text })}>
												{formatTimestamp(selectedToken.revokedAt)}
											</dd>
										</div>
									</dl>
									{selectedToken.revokedAt ? null : (
										<div>
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on('click', () => {
														if (!revokeConfirm) {
															revokeConfirm = true
															handle.update()
															return
														}
														void revokeSelectedToken()
													}),
													css(dangerButtonCss),
												]}
											>
												{saveState === 'revoking'
													? 'Revoking...'
													: revokeConfirm
														? 'Confirm revoke'
														: 'Revoke token'}
											</button>
										</div>
									)}
								</section>
							) : null}

							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>Owned packages</h2>
								<p mix={css(descriptionCss)}>
									Concrete package scopes must refer to packages owned by this
									account. Use <code>*</code> only for trusted personal clients.
								</p>
								{packages.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No saved packages yet.
									</p>
								) : (
									<ul
										mix={css({
											margin: 0,
											paddingLeft: spacing.lg,
											color: colors.text,
										})}
									>
										{packages.map((savedPackage) => (
											<li key={savedPackage.id}>
												<strong>{savedPackage.kodyId}</strong> -{' '}
												{savedPackage.name}
											</li>
										))}
									</ul>
								)}
							</section>
						</div>
					</section>
				) : null}
			</section>
		)
	}
}

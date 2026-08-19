import { formatTimestamp } from '#client/format-timestamp.ts'
import { readCommaListParams, readTrimmedParam } from '#client/url-params.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import {
	type AccountPackageDetail,
	type AccountPackageToken,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'
import { css, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { createDoubleCheck } from '#client/double-check.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { writeClipboardText } from '#client/clipboard.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAccentCalloutCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountInputCss,
	accountTextareaCss,
	TimestampValue,
} from './account-management-components.tsx'

const accountPackagesApiPath = '/account/packages.json'
const wildcardScope = '*'

type TokenEditorState = {
	name: string
	rawToken: string
	exportNamesText: string
	sourcesText: string
}

export function readPackageTokenQuery(href: string) {
	const url = new URL(href, 'http://localhost')
	return {
		isCreating: url.searchParams.get('newToken') === '1',
		selectedTokenId: url.searchParams.get('token')?.trim() || null,
	}
}

export function createTokenEditorStateFromHref(href: string): TokenEditorState {
	const params = new URL(href, 'http://localhost').searchParams
	return {
		name: readTrimmedParam(params, 'name') ?? '',
		rawToken: '',
		exportNamesText: readCommaListParams(params, [
			'exportName',
			'exportNames',
			'export_name',
			'export_names',
			'export-name',
			'export-names',
		]).join('\n'),
		sourcesText: readCommaListParams(params, [
			'source',
			'sources',
			'allowedSource',
			'allowedSources',
			'allowed_source',
			'allowed_sources',
			'allowed-source',
			'allowed-sources',
		]).join('\n'),
	}
}

function createEmptyEditorState(): TokenEditorState {
	return {
		name: '',
		rawToken: '',
		exportNamesText: '',
		sourcesText: '',
	}
}

function createEditorStateFromToken(
	token: AccountPackageToken,
): TokenEditorState {
	return {
		name: token.name,
		rawToken: '',
		exportNamesText: token.exportNames.join('\n'),
		sourcesText: token.sources.join('\n'),
	}
}

function generatePackageInvocationRawToken() {
	const cryptoApi = globalThis.crypto
	if (!cryptoApi?.getRandomValues) {
		throw new Error('This browser cannot generate secure random tokens.')
	}
	const bytes = new Uint8Array(32)
	cryptoApi.getRandomValues(bytes)
	return `kody_${bytesToBase64Url(bytes)}`
}

function parseListText(value: string) {
	return value
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

function formatScope(values: Array<string>) {
	if (values.length === 0) return 'None'
	if (values.includes(wildcardScope)) return 'Any export'
	return values.join(', ')
}

function formatSources(values: Array<string>) {
	if (values.length === 0) return 'Unlabeled only'
	return values.join(', ')
}

function tokenStatus(token: AccountPackageToken) {
	return token.revokedAt ? 'Revoked' : 'Active'
}

function hrefWithTokenQuery(
	href: string,
	next: { newToken?: boolean; tokenId?: string | null },
) {
	const url = new URL(href, 'http://localhost')
	if (next.newToken) url.searchParams.set('newToken', '1')
	else url.searchParams.delete('newToken')
	if (next.tokenId) url.searchParams.set('token', next.tokenId)
	else url.searchParams.delete('token')
	return `${url.pathname}${url.search}`
}

export function AccountPackageTokens(
	handle: Handle<{
		packageDetail: AccountPackageDetail
		currentHref: string
		username: string
		invocationUrlOrigin: string
		onPackagesPayload: (payload: AccountPackagesLoaderData) => void
	}>,
) {
	let editorState = createEmptyEditorState()
	let editMode = false
	let revealedRawToken: string | null = null
	let saveState:
		| 'idle'
		| 'creating'
		| 'updating'
		| 'revoking'
		| 'reinstating'
		| 'deleting' = 'idle'
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let lastCreateHref = ''
	const deleteTokenCheck = createDoubleCheck(handle as unknown as Handle)
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	async function submitAction(body: Record<string, unknown>) {
		const response = await fetch(accountPackagesApiPath, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify({
				packageId: handle.props.packageDetail.id,
				...body,
			}),
		})
		if (response.status === 401) {
			window.location.assign('/login')
			throw new Error('Signed out.')
		}
		const payload = await readJson<
			AccountPackagesLoaderData & { error?: string; selectedTokenId?: string }
		>(response)
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error ?? 'Unable to update package tokens.')
		}
		handle.props.onPackagesPayload(payload)
		return payload
	}

	return () => {
		const { packageDetail, currentHref, username, invocationUrlOrigin } =
			handle.props
		const query = readPackageTokenQuery(currentHref)
		if (query.isCreating && lastCreateHref !== currentHref) {
			lastCreateHref = currentHref
			editorState = createTokenEditorStateFromHref(currentHref)
			editMode = false
			deleteTokenCheck.reset()
		}
		const selectedToken =
			packageDetail.tokens.find(
				(token) => token.id === query.selectedTokenId,
			) ?? null
		const isMutating = saveState !== 'idle'
		const invocationUrl = username
			? `${invocationUrlOrigin}/@${username}/api/package-invocations/${packageDetail.kodyId}/<exportName>`
			: ''

		return (
			<section
				mix={css({
					display: 'grid',
					gap: spacing.md,
					paddingTop: spacing.sm,
					borderTop: `1px solid ${colors.border}`,
				})}
			>
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						alignItems: 'center',
						justifyContent: 'space-between',
						gap: spacing.sm,
					})}
				>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<h3
							mix={css({
								margin: 0,
								fontSize: typography.fontSize.base,
								fontWeight: typography.fontWeight.semibold,
							})}
						>
							Invocation tokens
						</h3>
						<p mix={css({ ...descriptionCss, margin: 0 })}>
							Bearer tokens for trusted clients that call this package over
							HTTP. Kody stores only the hash.
						</p>
					</div>
					<button
						type="button"
						disabled={isMutating}
						mix={[
							on('click', () => {
								revealedRawToken = null
								replaceLocation(
									hrefWithTokenQuery(currentHref, { newToken: true }),
								)
							}),
							css(primaryButtonCss),
						]}
					>
						New token
					</button>
				</div>

				{message ? (
					<p
						mix={css({
							margin: 0,
							color: messageTone === 'error' ? colors.error : colors.textMuted,
							fontSize: typography.fontSize.sm,
						})}
					>
						{message}
					</p>
				) : null}

				{revealedRawToken ? (
					<div mix={css(getAccentCalloutCss())}>
						<p mix={css({ ...descriptionCss, margin: 0 })}>
							Copy this raw token now. Kody stores only the hash and will not
							show the value again.
						</p>
						<div
							mix={css({
								display: 'grid',
								gridTemplateColumns: '1fr auto auto',
								gap: spacing.xs,
							})}
						>
							<input
								readOnly
								value={revealedRawToken}
								mix={css(accountInputCss)}
							/>
							<button
								type="button"
								mix={[
									on('click', () => {
										void writeClipboardText(revealedRawToken ?? '')
									}),
									css(secondaryButtonCss),
								]}
							>
								Copy
							</button>
							<button
								type="button"
								mix={[
									on('click', () => {
										revealedRawToken = null
										handle.update()
									}),
									css(secondaryButtonCss),
								]}
							>
								Done
							</button>
						</div>
					</div>
				) : null}

				{packageDetail.tokens.length === 0 && !query.isCreating ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						No tokens yet.
					</p>
				) : (
					<ul
						mix={css({
							display: 'grid',
							gap: spacing.sm,
							margin: 0,
							padding: 0,
							listStyle: 'none',
						})}
					>
						{packageDetail.tokens.map((token) => (
							<li
								key={token.id}
								mix={css({
									display: 'grid',
									gap: spacing.xs,
									padding: spacing.sm,
									borderRadius: radius.md,
									border: `1px solid ${
										selectedToken?.id === token.id
											? colors.primary
											: colors.border
									}`,
								})}
							>
								<div
									mix={css({
										display: 'flex',
										flexWrap: 'wrap',
										justifyContent: 'space-between',
										gap: spacing.sm,
									})}
								>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => {
												editMode = false
												revealedRawToken = null
												deleteTokenCheck.reset()
												replaceLocation(
													hrefWithTokenQuery(currentHref, {
														tokenId: token.id,
													}),
												)
											}),
											css({
												...getGhostButtonCss({ size: 'sm' }),
												justifyContent: 'flex-start',
												textAlign: 'left',
											}),
										]}
									>
										{token.name}
									</button>
									<span
										mix={css({
											fontSize: typography.fontSize.sm,
											color: token.revokedAt ? colors.error : colors.textMuted,
										})}
									>
										{tokenStatus(token)}
									</span>
								</div>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Exports: {formatScope(token.exportNames)}
								</p>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Sources: {formatSources(token.sources)}
								</p>
								{token.lastUsedAt ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Last used {formatTimestamp(token.lastUsedAt)}
									</p>
								) : null}
							</li>
						))}
					</ul>
				)}

				{query.isCreating || (selectedToken && editMode) ? (
					<form
						method="post"
						noValidate
						{...passwordManagerIgnoreProps}
						mix={[
							on('submit', (event) => {
								event.preventDefault()
								void (async () => {
									saveState = query.isCreating ? 'creating' : 'updating'
									message = null
									handle.update()
									try {
										const payload = await submitAction({
											action: query.isCreating
												? 'create-token'
												: 'update-token',
											id: selectedToken?.id,
											name: editorState.name,
											rawToken: editorState.rawToken,
											exportNames: parseListText(editorState.exportNamesText),
											sources: parseListText(editorState.sourcesText),
										})
										saveState = 'idle'
										messageTone = 'info'
										message = query.isCreating
											? 'Token created. Copy the raw value now; Kody will not show it again.'
											: 'Token updated.'
										if (query.isCreating) {
											revealedRawToken = editorState.rawToken
										}
										editorState = createEmptyEditorState()
										editMode = false
										replaceLocation(
											hrefWithTokenQuery(currentHref, {
												tokenId: payload.selectedTokenId ?? selectedToken?.id,
											}),
										)
									} catch (error) {
										saveState = 'idle'
										messageTone = 'error'
										message =
											error instanceof Error
												? error.message
												: 'Unable to save the token.'
									}
									handle.update()
								})()
							}),
							css(cardCss),
						]}
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h4 mix={css(cardTitleCss)}>
								{query.isCreating ? 'Create token' : 'Edit token'}
							</h4>
							<p mix={css(descriptionCss)}>
								{invocationUrl
									? `POST ${invocationUrl}`
									: 'Paste the raw token once. Kody stores only its hash.'}
							</p>
						</div>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Name</span>
							<input
								value={editorState.name}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (event.currentTarget instanceof HTMLInputElement) {
											editorState = {
												...editorState,
												name: event.currentTarget.value,
											}
											handle.update()
										}
									}),
								]}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>
								{query.isCreating ? 'Raw token' : 'New raw token (optional)'}
							</span>
							<div
								mix={css({
									display: 'grid',
									gridTemplateColumns: '1fr auto auto',
									gap: spacing.xs,
								})}
							>
								<input
									type="password"
									autocomplete="new-password"
									value={editorState.rawToken}
									mix={[
										css(accountInputCss),
										on('input', (event) => {
											if (event.currentTarget instanceof HTMLInputElement) {
												editorState = {
													...editorState,
													rawToken: event.currentTarget.value,
												}
												handle.update()
											}
										}),
									]}
								/>
								<button
									type="button"
									mix={[
										on('click', () => {
											try {
												editorState = {
													...editorState,
													rawToken: generatePackageInvocationRawToken(),
												}
											} catch (error) {
												messageTone = 'error'
												message =
													error instanceof Error
														? error.message
														: 'Unable to generate a token.'
											}
											handle.update()
										}),
										css(secondaryButtonCss),
									]}
								>
									Generate
								</button>
								<button
									type="button"
									disabled={!editorState.rawToken}
									mix={[
										on('click', () => {
											void writeClipboardText(editorState.rawToken)
										}),
										css(secondaryButtonCss),
									]}
								>
									Copy
								</button>
							</div>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Exports</span>
							<textarea
								value={editorState.exportNamesText}
								placeholder={'./process-video\n*'}
								mix={[
									css(accountTextareaCss),
									on('input', (event) => {
										if (event.currentTarget instanceof HTMLTextAreaElement) {
											editorState = {
												...editorState,
												exportNamesText: event.currentTarget.value,
											}
											handle.update()
										}
									}),
								]}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Allowed sources</span>
							<textarea
								value={editorState.sourcesText}
								placeholder="youtube-websub-proxy"
								mix={[
									css(accountTextareaCss),
									on('input', (event) => {
										if (event.currentTarget instanceof HTMLTextAreaElement) {
											editorState = {
												...editorState,
												sourcesText: event.currentTarget.value,
											}
											handle.update()
										}
									}),
								]}
							/>
						</label>
						<div
							mix={css({ display: 'flex', flexWrap: 'wrap', gap: spacing.sm })}
						>
							<button
								type="submit"
								disabled={isMutating}
								mix={css(primaryButtonCss)}
							>
								{saveState === 'creating' || saveState === 'updating'
									? 'Saving…'
									: 'Save token'}
							</button>
							<button
								type="button"
								disabled={isMutating}
								mix={[
									on('click', () => {
										editMode = false
										replaceLocation(
											hrefWithTokenQuery(currentHref, {
												tokenId: selectedToken?.id,
											}),
										)
									}),
									css(secondaryButtonCss),
								]}
							>
								Cancel
							</button>
						</div>
					</form>
				) : selectedToken ? (
					<div mix={css(cardCss)}>
						<h4 mix={css(cardTitleCss)}>{selectedToken.name}</h4>
						<p mix={css(descriptionCss)}>
							Created <TimestampValue value={selectedToken.createdAt} />
						</p>
						<div
							mix={css({ display: 'flex', flexWrap: 'wrap', gap: spacing.sm })}
						>
							<button
								type="button"
								disabled={isMutating || Boolean(selectedToken.revokedAt)}
								mix={[
									on('click', () => {
										editorState = createEditorStateFromToken(selectedToken)
										editMode = true
										handle.update()
									}),
									css(secondaryButtonCss),
								]}
							>
								Edit
							</button>
							{selectedToken.revokedAt ? (
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', () => {
											void (async () => {
												saveState = 'reinstating'
												handle.update()
												try {
													await submitAction({
														action: 'reinstate-token',
														id: selectedToken.id,
													})
													messageTone = 'info'
													message = 'Token reinstated.'
												} catch (error) {
													messageTone = 'error'
													message =
														error instanceof Error
															? error.message
															: 'Unable to reinstate the token.'
												}
												saveState = 'idle'
												handle.update()
											})()
										}),
										css(secondaryButtonCss),
									]}
								>
									Reinstate
								</button>
							) : (
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', () => {
											void (async () => {
												saveState = 'revoking'
												handle.update()
												try {
													await submitAction({
														action: 'revoke-token',
														id: selectedToken.id,
													})
													messageTone = 'info'
													message = 'Token revoked.'
												} catch (error) {
													messageTone = 'error'
													message =
														error instanceof Error
															? error.message
															: 'Unable to revoke the token.'
												}
												saveState = 'idle'
												handle.update()
											})()
										}),
										css(dangerButtonCss),
									]}
								>
									Revoke
								</button>
							)}
							<button
								type="button"
								disabled={isMutating}
								mix={[
									...deleteTokenCheck.getButtonMix({
										on: {
											click: () => {
												void (async () => {
													saveState = 'deleting'
													handle.update()
													try {
														await submitAction({
															action: 'delete-token',
															id: selectedToken.id,
														})
														messageTone = 'info'
														message = 'Token deleted.'
														replaceLocation(hrefWithTokenQuery(currentHref, {}))
													} catch (error) {
														messageTone = 'error'
														message =
															error instanceof Error
																? error.message
																: 'Unable to delete the token.'
													}
													saveState = 'idle'
													handle.update()
												})()
											},
										},
									}),
									css(dangerButtonCss),
								]}
							>
								{saveState === 'deleting'
									? 'Deleting…'
									: deleteTokenCheck.doubleCheck
										? 'Confirm delete'
										: 'Delete'}
							</button>
						</div>
					</div>
				) : null}
			</section>
		)
	}
}

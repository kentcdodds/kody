// remix-skill: shareable invite links on the package Collaborators tab.
import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import {
	type PackageInviteLinksView,
	type ScopedInviteLinkView,
} from '#universal/loader-data.ts'
import {
	type PackageCollaboratorPreset,
	packageCollaboratorPresetDescription,
} from '#universal/package-collaborators.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	formCss,
	iconWellCss,
	listCss,
	mutedCopyCss,
	readPreset,
	renderPresetOptions,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
	selectCss,
} from './package-collaborators-parts.tsx'

type CreatedLink = { id: string; url: string }

type InviteLinksResponse =
	| (PackageInviteLinksView & { inviteLink?: CreatedLink })
	| { ok: false; error?: string }

function creatorLabel(link: ScopedInviteLinkView) {
	if (link.createdByDisplayName?.trim()) return link.createdByDisplayName.trim()
	if (link.createdByUsername) return `@${link.createdByUsername}`
	return 'Someone'
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}

/**
 * Create, list, and revoke links that give one package's access to whoever
 * accepts. Works for personal and team orgs alike; the recipient becomes an
 * outside collaborator unless they already belong to the org.
 */
export function PackageInviteLinksPanel(
	handle: Handle<{
		username: string
		kodyId: string
		orgSlug: string
		personal: boolean
	}>,
) {
	let loadedFor: string | null = null
	let requestGeneration = 0
	let links: Array<ScopedInviteLinkView> = []
	let loadError: string | null = null
	let preset: PackageCollaboratorPreset = 'use'
	let maxUses = '1'
	let expiresInDays = '7'
	let busy: string | null = null
	let createdUrl: string | null = null
	let createdLinkId: string | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	function page() {
		return { username: handle.props.username, kodyId: handle.props.kodyId }
	}

	function currentKey() {
		return `${handle.props.username}/${handle.props.kodyId}`
	}

	/**
	 * `current` is false when the package changed or a newer request started
	 * while this one was in flight; its links are then dropped.
	 */
	async function request(body?: Record<string, unknown>) {
		const key = currentKey()
		const generation = ++requestGeneration
		const response = await fetch(
			body
				? routes.communityPackageInviteLinksApiPost.href(page())
				: routes.communityPackageInviteLinksApi.href(page()),
			{
				method: body ? 'POST' : 'GET',
				headers: {
					Accept: 'application/json',
					...(body ? { 'Content-Type': 'application/json' } : {}),
				},
				credentials: 'include',
				signal: handle.signal,
				...(body ? { body: JSON.stringify(body) } : {}),
			},
		)
		const payload = (await response
			.json()
			.catch(() => null)) as InviteLinksResponse | null
		if (!response.ok || !payload?.ok) {
			throw new Error(
				(payload && !payload.ok ? payload.error : null) ||
					'Kody could not load invite links.',
			)
		}
		const current = key === loadedFor && generation === requestGeneration
		if (current) links = payload.links
		return { payload, current }
	}

	async function load(key: string) {
		try {
			const { current } = await request()
			if (!current) return
			loadError = null
		} catch (error) {
			if (handle.signal.aborted || loadedFor !== key) return
			loadError =
				error instanceof Error ? error.message : 'Unable to load invite links.'
		}
		if (loadedFor === key) handle.update()
	}

	async function create(event: SubmitEvent) {
		event.preventDefault()
		if (busy) return
		busy = 'create'
		message = null
		handle.update()
		try {
			const { payload, current } = await request({
				action: 'create',
				preset,
				maxUses: maxUses.trim() || null,
				expiresInDays: expiresInDays.trim() || '7',
			})
			if (!current) return
			createdUrl = payload.inviteLink?.url ?? null
			createdLinkId = payload.inviteLink?.id ?? null
			const copied = createdUrl ? await copyText(createdUrl) : false
			message = copied
				? 'Invite link copied to clipboard.'
				: 'Invite link created. Copy it below; it is shown only once.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to create that invite link.'
			messageTone = 'error'
		} finally {
			busy = null
			handle.update()
		}
	}

	async function revoke(linkId: string) {
		if (busy) return
		busy = `revoke:${linkId}`
		message = null
		handle.update()
		try {
			const { current } = await request({ action: 'revoke', linkId })
			if (!current) return
			if (linkId === createdLinkId) {
				createdUrl = null
				createdLinkId = null
			}
			message = 'Invite link revoked.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to revoke that invite link.'
			messageTone = 'error'
		} finally {
			busy = null
			handle.update()
		}
	}

	function renderLink(link: ScopedInviteLinkView) {
		return (
			<li key={link.id} mix={css(rowCss)} data-testid="package-invite-link">
				<span aria-hidden="true" mix={css(iconWellCss)}>
					{renderIcon('link', { size: '1.25rem' })}
				</span>
				<span mix={css(rowTextCss)}>
					<span mix={css(rowNameCss)}>{link.label} link</span>
					<span mix={css(rowDetailCss)}>
						{[
							`${link.useCount}${link.maxUses != null ? ` / ${link.maxUses}` : ''} uses`,
							`Expires ${formatTimestampDate(link.expiresAt)}`,
							`Created by ${creatorLabel(link)}`,
						].join(' · ')}
					</span>
				</span>
				<span mix={css(rowActionsCss)}>
					<button
						type="button"
						disabled={busy !== null}
						mix={[
							css(getDangerPillCss({ size: 'sm' })),
							on('click', () => void revoke(link.id)),
						]}
					>
						{busy === `revoke:${link.id}` ? 'Revoking…' : 'Revoke'}
					</button>
				</span>
			</li>
		)
	}

	return () => {
		const key = currentKey()
		if (loadedFor !== key && typeof document !== 'undefined') {
			loadedFor = key
			links = []
			createdUrl = null
			createdLinkId = null
			message = null
			void load(key)
		}
		return (
			<AccountManagementPanel
				title="Share with a link"
				description={
					handle.props.personal
						? 'Anyone who accepts the link gets this access to the package as an outside collaborator.'
						: `Anyone who accepts the link gets this access to the package. People who are not members of @${handle.props.orgSlug} become outside collaborators; the link never adds anyone to the organization.`
				}
			>
				<form
					data-testid="package-invite-link-form"
					mix={[css(formCss), on('submit', (event) => void create(event))]}
				>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>Access</span>
						<select
							aria-label="Access for the invite link"
							value={preset}
							mix={[
								css(selectCss),
								on('change', (event) => {
									const next = readPreset(event)
									if (!next) return
									preset = next
									handle.update()
								}),
							]}
						>
							{renderPresetOptions(preset)}
						</select>
						<p mix={css(accountFieldNoteCss)}>
							{packageCollaboratorPresetDescription(preset)}.
						</p>
					</label>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>Max uses</span>
						<input
							value={maxUses}
							data-field-ring
							inputMode="numeric"
							autoComplete="off"
							placeholder="Unlimited"
							aria-label="Max uses"
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									maxUses = (event.currentTarget as HTMLInputElement).value
								}),
							]}
						/>
						<p mix={css(accountFieldNoteCss)}>
							One person per use. Leave blank to let anyone with the link
							accept.
						</p>
					</label>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>Expires in days</span>
						<input
							value={expiresInDays}
							data-field-ring
							inputMode="numeric"
							autoComplete="off"
							aria-label="Expires in days"
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									expiresInDays = (event.currentTarget as HTMLInputElement)
										.value
								}),
							]}
						/>
					</label>
					<div mix={css(accountActionsCss)}>
						<button
							type="submit"
							disabled={busy !== null}
							data-testid="package-invite-link-create"
							mix={css(getPillButtonCss({ size: 'sm' }))}
						>
							{renderIcon('link', { size: '1.05rem' })}
							{busy === 'create' ? 'Creating…' : 'Create invite link'}
						</button>
					</div>
				</form>
				{message ? (
					<p
						role={messageTone === 'error' ? 'alert' : 'status'}
						mix={css(messageTone === 'error' ? errorCss : statusCss)}
					>
						{message}
					</p>
				) : null}
				{createdUrl ? (
					<div mix={css(createdCss)} data-testid="package-invite-link-url">
						<code mix={css(createdCodeCss)}>{createdUrl}</code>
						<button
							type="button"
							mix={[
								css(getPillButtonCss({ size: 'sm' })),
								on('click', () => {
									const url = createdUrl
									if (!url) return
									void copyText(url).then((copied) => {
										message = copied
											? 'Invite link copied to clipboard.'
											: 'Could not copy the link. Select it manually.'
										messageTone = copied ? 'info' : 'error'
										handle.update()
									})
								}),
							]}
						>
							{renderIcon('copy', { size: '1.05rem' })}
							Copy again
						</button>
					</div>
				) : null}
				{loadError ? (
					<p role="alert" mix={css(errorCss)}>
						{loadError}
					</p>
				) : links.length > 0 ? (
					<ul mix={css(linksListCss)} data-testid="package-invite-links">
						{links.map(renderLink)}
					</ul>
				) : (
					<p mix={css(linksEmptyCss)}>No active invite links.</p>
				)}
			</AccountManagementPanel>
		)
	}
}

const statusCss = {
	margin: `${spacing.md} 0 0`,
	color: colors.text,
}

const errorCss = {
	margin: `${spacing.md} 0 0`,
	color: colors.danger,
}

const createdCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.lg,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const createdCodeCss = {
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
	color: colors.text,
}

const linksListCss = {
	...listCss,
	marginTop: spacing.lg,
}

const linksEmptyCss = {
	...mutedCopyCss,
	marginTop: spacing.lg,
}

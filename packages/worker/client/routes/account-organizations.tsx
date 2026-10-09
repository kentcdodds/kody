import { type Handle, type RemixNode, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { type IconName, renderIcon } from '#universal/icon.tsx'
import { type AccountInvitesLoaderData } from '#universal/loader-data.ts'
import {
	currentSwitcherSlug,
	orderOrganizations,
	orgIdentity,
	orgRoleLabel,
	organizationsWithSignupFallback,
	type OrganizationSummary,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	mergeCss,
} from '#universal/styles/style-primitives.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	noticeCardCss,
} from './account-management-components.tsx'

type OrgViewer = { displayName: string; avatarUrl: string | null }

/**
 * One organization as a row: avatar, name, handle, and trailing pills. A row
 * with an `href` is a link card; without one it is a plain listing (invites
 * point at organizations the person cannot open yet).
 */
function renderOrgRow(input: {
	key: string
	slug: string
	displayName: string | null
	personal: boolean
	viewer: OrgViewer
	detail: string | null
	pills: Array<{ label: string; tone: 'accent' | 'quiet' }>
	href?: string
	testId: string
	trailing?: RemixNode
}) {
	const identity = orgIdentity(input, input.viewer)
	const detail = [identity.hasName ? identity.handle : null, input.detail]
		.filter(Boolean)
		.join(' · ')
	const body = (
		<>
			<UserAvatar
				displayName={identity.avatarName}
				avatarUrl={identity.avatarUrl}
				size={44}
				variant="well"
			/>
			<span mix={css(orgRowTextCss)}>
				<span mix={css(orgRowNameCss)}>{identity.name}</span>
				{detail ? <span mix={css(orgRowDetailCss)}>{detail}</span> : null}
			</span>
			{input.pills.length > 0 ? (
				<span mix={css(orgRowPillsCss)}>
					{input.pills.map((pill) => (
						<span
							key={pill.label}
							mix={css(pill.tone === 'accent' ? accentPillCss : quietPillCss)}
						>
							{pill.label}
						</span>
					))}
				</span>
			) : null}
			{input.trailing ?? null}
		</>
	)
	return (
		<li key={input.key} data-testid={input.testId} mix={css(orgRowItemCss)}>
			{input.href ? (
				<a href={input.href} mix={css(mergeCss(orgRowCss, orgRowLinkCss))}>
					{body}
					<span aria-hidden="true" mix={css(orgRowChevronCss)}>
						{renderIcon('chevron-right', { size: '1.1rem' })}
					</span>
				</a>
			) : (
				<div mix={css(orgRowCss)}>{body}</div>
			)}
		</li>
	)
}

function renderButtonIcon(name: IconName) {
	return renderIcon(name, { size: '1.05rem' })
}

/**
 * Account overview's Organizations section: every organization the person
 * belongs to, the one the header is acting in marked Current, then the
 * create and invites actions.
 */
export function renderAccountOrganizationsPanel(input: {
	organizations: ReadonlyArray<OrganizationSummary>
	username: string
	viewer: OrgViewer
	inviteCount: number
	lastUsedOrganization: string | null
	currentPathname: string
}) {
	const organizations = orderOrganizations(
		organizationsWithSignupFallback({
			organizations: input.organizations,
			username: input.username,
		}),
	)
	const currentSlug = currentSwitcherSlug({
		pathname: input.currentPathname,
		organizations,
		lastUsedSlug: input.lastUsedOrganization,
	})
	return (
		<AccountManagementPanel
			title="Organizations"
			description="Each organization has its own packages, secrets, and members. Switch between them from the header."
			ariaLabel="Organizations"
		>
			<ul mix={css(orgListCss)} data-testid="account-organizations">
				{organizations.map((org) =>
					renderOrgRow({
						key: org.slug,
						slug: org.slug,
						displayName: org.displayName,
						personal: org.personal,
						viewer: input.viewer,
						detail: orgRoleLabel(org.role),
						pills:
							org.slug === currentSlug
								? [{ label: 'Current', tone: 'accent' }]
								: [],
						href: routes.profile.href({ username: org.slug }),
						testId: 'account-organization',
					}),
				)}
			</ul>
			<div mix={css(accountActionsCss)}>
				<a
					href={routes.accountOrganizationsNew.href()}
					mix={css(getGhostButtonCss({ size: 'sm' }))}
				>
					{renderButtonIcon('plus')}
					Create organization
				</a>
				<a
					href={routes.accountInvites.href()}
					mix={css(getGhostButtonCss({ size: 'sm' }))}
				>
					{renderButtonIcon('mail')}
					Invites
					{input.inviteCount > 0 ? (
						<span mix={css(countBadgeCss)}>{input.inviteCount}</span>
					) : null}
				</a>
			</div>
		</AccountManagementPanel>
	)
}

/** Lowercase, hyphenated, and trimmed to the slug rules, for the auto-fill. */
function slugFromName(name: string) {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32)
		.replace(/-+$/g, '')
}

export async function accountOrganizationsNewRouteLoader(): Promise<RouteLoaderResult> {
	return {}
}

export function AccountOrganizationsNewRoute(handle: Handle) {
	const initialHref = readCurrentRouterHref(handle)
	const consumed = tryConsumeRouteLoaderData(
		handle,
		'accountOrganizations',
		initialHref,
	)
	const initialSearch = new URL(initialHref, 'http://localhost').searchParams
	let draftName =
		consumed?.draft.displayName ?? initialSearch.get('displayName') ?? ''
	let draftSlug = consumed?.draft.slug ?? initialSearch.get('slug') ?? ''
	// A slug the person typed (or one sent back with an error) is theirs; only
	// an untouched slug follows the name.
	let slugEdited = draftSlug.length > 0

	return () => {
		const href = readCurrentRouterHref(handle)
		const error =
			consumed?.error ??
			new URL(href, 'http://localhost').searchParams.get('error')
		return (
			<AccountManagementShell maxWidth="40rem">
				<AccountPageHeader
					title="Create organization"
					description="An organization owns its own packages, secrets, and members, separate from your personal account."
					currentHref={href}
				/>
				{error ? (
					<AccountManagementMessage tone="error">
						{error}
					</AccountManagementMessage>
				) : null}
				<AccountManagementPanel title="Details">
					<form
						method="post"
						action={routes.accountOrganizationsNewPost.href()}
						data-testid="create-organization-form"
						mix={css(formCss)}
					>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Name</span>
							<input
								name="displayName"
								required
								maxLength={80}
								autoComplete="organization"
								value={draftName}
								data-field-ring
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										draftName = (event.currentTarget as HTMLInputElement).value
										if (!slugEdited) draftSlug = slugFromName(draftName)
										handle.update()
									}),
								]}
							/>
							<p mix={css(accountFieldNoteCss)}>
								Shown in the header and to members. You can change it later.
							</p>
						</label>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Handle</span>
							<span mix={css(slugFieldCss)}>
								<span aria-hidden="true" mix={css(slugPrefixCss)}>
									kody.codes/@
								</span>
								<input
									name="slug"
									required
									minLength={3}
									maxLength={32}
									pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{1,30}[a-zA-Z0-9]"
									autoCapitalize="none"
									autoComplete="off"
									spellCheck={false}
									aria-describedby="create-organization-slug-note"
									value={draftSlug}
									data-field-ring
									mix={[
										css(slugInputCss),
										on('input', (event) => {
											draftSlug = (event.currentTarget as HTMLInputElement)
												.value
											slugEdited = draftSlug.length > 0
											handle.update()
										}),
									]}
								/>
							</span>
							<p
								id="create-organization-slug-note"
								mix={css(accountFieldNoteCss)}
							>
								3 to 32 letters, numbers, and hyphens. The handle is the
								organization's address and cannot be changed later.
							</p>
						</label>
						<div mix={css(accountActionsCss)}>
							<button type="submit" mix={css(getPillButtonCss({ size: 'sm' }))}>
								Create organization
							</button>
							<a
								href={routes.account.href()}
								mix={css(getGhostButtonCss({ size: 'sm' }))}
							>
								Cancel
							</a>
						</div>
					</form>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}

async function fetchInvites(signal: AbortSignal) {
	const response = await fetch(routes.accountInvitesApi.href(), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized' as const
	const payload = await readJson<AccountInvitesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load invites.')
	}
	return payload
}

export async function accountInvitesRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchInvites(signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	return { accountInvites: payload }
}

function inviteRoleLabel(invite: AccountInvitesLoaderData['invites'][number]) {
	if (invite.kind !== 'membership') return 'Access grant'
	switch (invite.role) {
		case 'owner':
		case 'member':
		case 'billing':
			return `${orgRoleLabel(invite.role)} invite`
		default:
			return 'Membership invite'
	}
}

export function AccountInvitesRoute(handle: Handle) {
	const invitesData = createRouteData({
		key: 'accountInvites',
		async load(_href, signal) {
			const payload = await fetchInvites(signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			return payload
		},
	})

	return () => {
		const href = readCurrentRouterHref(handle)
		const snapshot = invitesData.read(handle, href)
		const invites = snapshot.data?.ok ? snapshot.data.invites : []
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && !snapshot.data
					? 'loading'
					: 'ready'
		return (
			<AccountManagementShell busy={pending && Boolean(snapshot.data)}>
				<AccountPageHeader
					title="Invites"
					description="Invitations to join an organization. To accept one, paste the invite prompt you were sent into your agent."
					currentHref={href}
				/>
				<AccountManagementPanel title="Pending invites">
					{status === 'loading' ? (
						<p role="status" mix={css(mutedCopyCss)}>
							Loading invites…
						</p>
					) : null}
					{status === 'error' ? (
						<div mix={css(noticeCardCss)} data-testid="invites-error">
							<AccountManagementMessage tone="error">
								{snapshot.error?.message ?? 'Unable to load invites.'}
							</AccountManagementMessage>
							<div>
								<button
									type="button"
									mix={[
										css(getGhostButtonCss({ size: 'sm' })),
										on('click', () => invitesData.reload(handle, href)),
									]}
								>
									Try again
								</button>
							</div>
						</div>
					) : null}
					{status === 'ready' && invites.length === 0 ? (
						<div mix={css(emptyStateCss)} data-testid="invites-empty">
							<span aria-hidden="true" mix={css(emptyIconCss)}>
								{renderIcon('inbox', { size: '1.5rem' })}
							</span>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<p mix={css(emptyTitleCss)}>No invites waiting</p>
								<p mix={css(mutedCopyCss)}>
									When someone invites you to an organization, it shows up here.
								</p>
							</div>
						</div>
					) : null}
					{status === 'ready' && invites.length > 0 ? (
						<ul mix={css(orgListCss)} data-testid="invites-list">
							{invites.map((invite) =>
								renderOrgRow({
									key: invite.id,
									slug: invite.orgSlug,
									displayName: invite.orgDisplayName,
									personal: false,
									viewer: { displayName: '', avatarUrl: null },
									detail: `Expires ${formatTimestampDate(invite.expiresAt)}`,
									pills: [{ label: inviteRoleLabel(invite), tone: 'quiet' }],
									testId: 'invite',
								}),
							)}
						</ul>
					) : null}
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}

const orgListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const orgRowItemCss = {
	minWidth: 0,
}

const orgRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
}

const orgRowLinkCss = {
	transition: `border-color ${transitions.fast}, transform ${transitions.fast}`,
	'&:active': { transform: 'scale(0.995)' },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted, color: colors.text },
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { transform: 'none' },
	},
}

const orgRowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const orgRowNameCss = {
	fontWeight: 650,
	fontSize: '1rem',
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const orgRowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	lineHeight: 1.3,
	overflowWrap: 'anywhere' as const,
}

const orgRowPillsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'flex-end',
	gap: spacing.xs,
	flexShrink: 0,
}

const pillBaseCss = {
	display: 'inline-flex',
	alignItems: 'center',
	fontSize: '0.8rem',
	fontWeight: 600,
	lineHeight: 1.4,
	borderRadius: radius.full,
	padding: '0.1rem 0.6rem',
	whiteSpace: 'nowrap' as const,
}

const accentPillCss = {
	...pillBaseCss,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const quietPillCss = {
	...pillBaseCss,
	color: colors.textMuted,
	boxShadow: `inset 0 0 0 1px ${colors.border}`,
}

const orgRowChevronCss = {
	display: 'inline-flex',
	flexShrink: 0,
	color: colors.textMuted,
}

const countBadgeCss = {
	minWidth: '1.35rem',
	padding: '0.1rem 0.4rem',
	boxSizing: 'border-box' as const,
	borderRadius: radius.full,
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontSize: typography.fontSize.xs,
	fontWeight: 700,
	lineHeight: 1.3,
	textAlign: 'center' as const,
	fontVariantNumeric: 'tabular-nums',
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

const slugFieldCss = {
	display: 'flex',
	alignItems: 'stretch',
	minWidth: 0,
}

const slugPrefixCss = {
	display: 'inline-flex',
	alignItems: 'center',
	paddingInline: '0.85rem',
	borderRadius: '12px 0 0 12px',
	border: `1.5px solid ${colors.fieldBorder}`,
	borderRight: 'none',
	backgroundColor: colors.background,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}

const slugInputCss = {
	...accountInputCss,
	flex: '1 1 auto',
	minWidth: 0,
	borderTopLeftRadius: 0,
	borderBottomLeftRadius: 0,
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
}

const emptyStateCss = {
	...noticeCardCss,
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const emptyIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '3rem',
	height: '3rem',
	borderRadius: radius.full,
	border: `1px dashed ${colors.border}`,
	color: colors.textMuted,
}

const emptyTitleCss = {
	margin: 0,
	fontWeight: 650,
	color: colors.text,
}

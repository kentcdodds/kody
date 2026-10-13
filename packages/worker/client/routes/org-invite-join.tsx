import { type Handle, css } from 'remix/component'
import { ErrorAgentPromptButton } from '#client/error-agent-prompt-button.tsx'
import { on } from '#client/event-mixin.ts'
import { buildErrorAgentPrompt } from '#universal/error-agent-prompt.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData } from '#client/route-data.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { renderIcon } from '#universal/icon.tsx'
import { type OrgInviteJoinLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	cardCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

function orgLabel(data: Extract<OrgInviteJoinLoaderData, { ok: true }>) {
	return data.org.displayName?.trim() || data.org.slug
}

function tokenFromHref(href: string) {
	const match = /^\/join\/([^/?#]+)/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ? decodeURIComponent(match[1]) : ''
}

async function fetchJoin(
	token: string,
	signal: AbortSignal,
): Promise<OrgInviteJoinLoaderData> {
	const response = await fetch(routes.orgInviteJoin.href({ token }), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	const payload = (await response.json().catch(() => null)) as {
		orgInviteJoin?: OrgInviteJoinLoaderData
	} | null
	if (!payload?.orgInviteJoin) {
		return {
			ok: false,
			error: 'Unable to load this invite link.',
			reason: 'invalid',
		}
	}
	return payload.orgInviteJoin
}

export async function orgInviteJoinRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const token = tokenFromHref(url.pathname)
	if (!token) {
		return {
			orgInviteJoin: {
				ok: false,
				error: 'Invite link token is required.',
				reason: 'missing',
			} satisfies OrgInviteJoinLoaderData,
		}
	}
	return { orgInviteJoin: await fetchJoin(token, signal) }
}

export function OrgInviteJoinRoute(handle: Handle) {
	let joining = false
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	const joinData = createRouteData({
		key: 'orgInviteJoin',
		fromLoaderData: (payload) => payload,
		async load(href, signal) {
			const token = tokenFromHref(href)
			if (!token) {
				return {
					ok: false,
					error: 'Invite link token is required.',
					reason: 'missing',
				} satisfies OrgInviteJoinLoaderData
			}
			return await fetchJoin(token, signal)
		},
	})

	async function join(token: string) {
		joining = true
		message = null
		handle.update()
		try {
			const response = await fetch(routes.orgInviteJoinPost.href({ token }), {
				method: 'POST',
				headers: { Accept: 'application/json' },
				credentials: 'include',
				redirect: 'manual',
			})
			if (response.status === 401 || response.type === 'opaqueredirect') {
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(
						routes.orgInviteJoin.href({ token }),
					)}`,
				)
				return
			}
			const payload = (await response.json().catch(() => null)) as {
				ok?: boolean
				error?: string
				alreadyMember?: boolean
				redirectTo?: string
			} | null
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to join this organization.')
			}
			message = payload.alreadyMember
				? 'You are already a member of this organization.'
				: 'You joined the organization.'
			messageTone = 'info'
			handle.update()
			window.location.assign(payload.redirectTo || '/')
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to join this organization.'
			messageTone = 'error'
			joining = false
			handle.update()
		}
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		const snapshot = joinData.read(handle, href)
		const data =
			snapshot.data ??
			({
				ok: false,
				error: 'Open an invite link to join an organization.',
				reason: 'missing',
			} satisfies OrgInviteJoinLoaderData)

		if (!data.ok) {
			const loadErrorMessage =
				snapshot.kind === 'error'
					? (snapshot.error?.message ?? 'Unable to load this invite link.')
					: null
			const resolvedFailure =
				(snapshot.data != null && snapshot.data.ok === false) ||
				loadErrorMessage != null
			const failureMessage = loadErrorMessage ?? data.error
			return (
				<section mix={css(pageCss)}>
					<header mix={css(pageHeaderCss)}>
						<h1 mix={css(pageTitleCss)}>Invite link</h1>
						<p mix={css(pageDescriptionCss)}>
							{resolvedFailure
								? 'This invite link cannot be used.'
								: 'Loading this invite link…'}
						</p>
					</header>
					<div mix={css(cardCss)}>
						{resolvedFailure ? (
							<>
								<p role="alert" mix={css(bodyCss)}>
									{failureMessage}
								</p>
								<ErrorAgentPromptButton
									prompt={buildErrorAgentPrompt({
										activity: 'Opening an organization invite link.',
										errorCode: 'org_invite_unusable',
										errorMessage: failureMessage,
										ids: { path: '/join' },
										likelyCause:
											'The invite expired, was revoked, or the token is invalid.',
										nextSteps: [
											'Ask the org owner to send a fresh invite.',
											'Confirm I am signed in as the invited email.',
										],
										kodyTools: ['search({ entity: "guide:organizations" })'],
										docs: ['search({ entity: "guide:organizations" })'],
									})}
								/>
							</>
						) : (
							<p role="status" mix={css(bodyCss)}>
								Loading…
							</p>
						)}
						<p mix={css(footerCss)}>
							<a href="/" mix={css(mutedLinkCss)}>
								Go home
							</a>
						</p>
					</div>
				</section>
			)
		}

		const name = orgLabel(data)
		const loginHref = `/login?redirectTo=${encodeURIComponent(
			routes.orgInviteJoin.href({ token: data.token }),
		)}`
		const signupHref = `/signup?redirectTo=${encodeURIComponent(
			routes.orgInviteJoin.href({ token: data.token }),
		)}`

		return (
			<section mix={css(pageCss)} data-testid="org-invite-join">
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>Join {name}</h1>
					<p mix={css(pageDescriptionCss)}>
						{data.alreadyMember
							? `You already belong to ${name}.`
							: `You are invited to join ${name} as ${data.roleLabel}.`}
					</p>
				</header>
				<div mix={css(cardCss)}>
					<div mix={css(orgRowCss)}>
						<UserAvatar
							displayName={name}
							avatarUrl={data.org.avatarUrl}
							size={56}
							variant="well"
						/>
						<div mix={css(orgTextCss)}>
							<p mix={css(orgNameCss)}>{name}</p>
							<p mix={css(orgDetailCss)}>@{data.org.slug}</p>
						</div>
					</div>
					{message ? (
						<>
							<p
								role={messageTone === 'error' ? 'alert' : 'status'}
								mix={css(
									messageTone === 'error' ? errorMessageCss : infoMessageCss,
								)}
							>
								{message}
							</p>
							{messageTone === 'error' ? (
								<>
									<ErrorAgentPromptButton
										prompt={buildErrorAgentPrompt({
											activity: 'Joining an organization from an invite link.',
											errorCode: 'org_invite_join_failed',
											errorMessage: message,
											ids: { path: '/join', orgSlug: data.org.slug },
											likelyCause:
												'The invite could not be accepted (expired, already used, or permission issue).',
											nextSteps: [
												'Ask the org owner to send a fresh invite.',
												'Confirm I am signed in as the invited email.',
											],
											kodyTools: ['search({ entity: "guide:organizations" })'],
											docs: ['search({ entity: "guide:organizations" })'],
										})}
									/>
								</>
							) : null}
						</>
					) : null}
					{data.alreadyMember ? (
						<p mix={css(footerCss)}>
							<a href={`/@${data.org.slug}`} mix={css(getPrimaryButtonCss())}>
								Open {name}
							</a>
						</p>
					) : data.authenticated ? (
						<div mix={css(actionsCss)}>
							<button
								type="button"
								disabled={joining}
								data-testid="org-invite-join-confirm"
								mix={[
									css(getPrimaryButtonCss()),
									on('click', () => void join(data.token)),
								]}
							>
								{renderIcon('plus', { size: '1.05rem' })}
								{joining ? 'Joining…' : `Join ${name}`}
							</button>
						</div>
					) : (
						<div mix={css(actionsCss)}>
							<a href={loginHref} mix={css(getPrimaryButtonCss())}>
								Sign in to join
							</a>
							<a href={signupHref} mix={css(getSecondaryButtonCss())}>
								Create an account
							</a>
						</div>
					)}
				</div>
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '36rem',
}

const bodyCss = {
	margin: 0,
	color: colors.text,
	fontSize: typography.fontSize.base,
	lineHeight: 1.5,
}

const footerCss = {
	margin: `${spacing.lg} 0 0`,
}

const orgRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	marginBottom: spacing.lg,
}

const orgTextCss = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
}

const orgNameCss = {
	margin: 0,
	fontWeight: 650,
	fontSize: typography.fontSize.lg,
}

const orgDetailCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
}

const infoMessageCss = {
	margin: `0 0 ${spacing.md}`,
	color: colors.text,
}

const errorMessageCss = {
	margin: `0 0 ${spacing.md}`,
	color: colors.danger,
}

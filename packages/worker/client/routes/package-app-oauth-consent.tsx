import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementHeader,
	AccountManagementShell,
	IdValue,
	MetadataGrid,
	accountActionsCss,
	accountDisclosureCss,
} from '#client/routes/account-management-components.tsx'
import { type PackageAppOauthConsentLoaderData } from '#universal/loader-data.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

/**
 * Consent is always a full document load so hidden OAuth fields and skip
 * logic come from the authorize handler, never a client cache.
 */
export async function packageAppOauthConsentRouteLoader(
	url: URL,
): Promise<RouteLoaderResult> {
	return routeLoaderRedirect(`${url.pathname}${url.search}`)
}

function isPackageAppOauthConsentPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname ===
		packageAppOauthPaths.authorize
	)
}

export function PackageAppOauthConsentRoute(handle: Handle) {
	let data: PackageAppOauthConsentLoaderData | null = null

	return () => {
		const href = readCurrentRouterHref(handle)
		if (!isPackageAppOauthConsentPath(href)) {
			return (
				<AccountManagementShell maxWidth="40rem">{null}</AccountManagementShell>
			)
		}
		const consumed = tryConsumeRouteLoaderData(
			handle,
			'packageAppOauthConsent',
			href,
		)
		if (consumed) data = consumed

		if (!data) {
			return (
				<AccountManagementShell maxWidth="40rem">
					<AccountManagementHeader
						title="Allow this app?"
						description="Loading authorization details…"
					/>
				</AccountManagementShell>
			)
		}

		const detailItems = [
			{
				label: 'Client ID',
				value: <IdValue value={data.clientId} label="client id" />,
			},
			{
				label: 'Package id',
				value: <IdValue value={data.kodyId} label="package id" />,
			},
			{
				label: 'Publisher handle',
				value: <IdValue value={data.publisherUsername} label="publisher" />,
			},
			{
				label: 'Redirect URI',
				value: <IdValue value={data.redirectUri} label="redirect uri" />,
			},
			{
				label: 'Scopes',
				value: <IdValue value={data.scopes.join(' ')} label="scopes" />,
			},
		]

		return (
			<AccountManagementShell maxWidth="40rem">
				<AccountManagementHeader
					eyebrow={
						<p
							data-testid="package-app-oauth-consent-package"
							mix={css(packageContextCss)}
						>
							{data.packageName}
						</p>
					}
					title={`Allow ${data.packageName}?`}
					description={`${data.packageName} wants to use your Kody account. Review what it can see, then allow or cancel.`}
				/>
				<section
					data-testid="package-app-oauth-consent"
					mix={css({ display: 'grid', gap: spacing.lg })}
				>
					<div mix={css(identityRowCss)}>
						{data.iconUrl ? (
							<img
								src={data.iconUrl}
								alt=""
								width={48}
								height={48}
								mix={css(iconCss)}
							/>
						) : (
							<span aria-hidden="true" mix={css(iconFallbackCss)}>
								{data.packageName.slice(0, 1).toUpperCase()}
							</span>
						)}
						<div mix={css({ display: 'grid', gap: spacing.xs, minWidth: 0 })}>
							<strong
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
									overflowWrap: 'anywhere',
								})}
							>
								{data.packageName}
							</strong>
							<p mix={css(mutedCss)}>
								Published by {data.publisherDisplayName} (@
								{data.publisherUsername})
							</p>
							{data.appDomain ? (
								<p mix={css(mutedCss)}>
									App domain <code mix={css(codeCss)}>{data.appDomain}</code>
								</p>
							) : null}
							<p mix={css(mutedCss)}>Signed in as {data.viewerDisplayName}</p>
						</div>
					</div>

					<section mix={css({ display: 'grid', gap: spacing.sm })}>
						<h2 mix={css(sectionHeadingCss)}>This app will be able to</h2>
						<ul mix={css(claimListCss)}>
							{data.claimLabels.map((claim) => (
								<li key={claim}>{claim}</li>
							))}
						</ul>
					</section>

					<details
						data-testid="package-app-oauth-consent-details"
						mix={css(accountDisclosureCss)}
					>
						<summary>Details</summary>
						<MetadataGrid items={detailItems} />
					</details>

					<form
						method="post"
						action={packageAppOauthPaths.authorize}
						data-router-skip
						mix={css(accountActionsCss)}
					>
						{Object.entries(data.hiddenFields).map(([name, value]) => (
							<input key={name} type="hidden" name={name} value={value} />
						))}
						<button
							type="submit"
							name="decision"
							value="approve"
							data-testid="package-app-oauth-approve"
							mix={css(getPillButtonCss({ size: 'sm' }))}
						>
							Allow
						</button>
						<button
							type="submit"
							name="decision"
							value="deny"
							data-testid="package-app-oauth-deny"
							mix={css(getGhostButtonCss({ size: 'sm' }))}
						>
							Cancel
						</button>
					</form>
				</section>
			</AccountManagementShell>
		)
	}
}

const packageContextCss = {
	margin: 0,
	width: 'fit-content',
	maxWidth: '100%',
	overflowWrap: 'anywhere' as const,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
	borderRadius: radius.full,
	padding: '0.2rem 0.7rem',
}

const identityRowCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	minWidth: 0,
}

const iconCss = {
	width: '3rem',
	height: '3rem',
	borderRadius: radius.md,
	objectFit: 'cover' as const,
	backgroundColor: colors.logoWell,
	flexShrink: 0,
}

const iconFallbackCss = {
	...iconCss,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const codeCss = {
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
}

const sectionHeadingCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const claimListCss = {
	margin: 0,
	paddingLeft: '1.15rem',
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}

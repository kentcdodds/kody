import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import {
	oauthAuthorizeGrantHeading,
	oauthAuthorizeOrgField,
	type OAuthAuthorizeConsentOrg,
} from '#client/routes/oauth-authorize-form.ts'
import { spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAlertCardCss,
	inputCss,
	nativeDisclosureCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'

function orgOptionLabel(org: OAuthAuthorizeConsentOrg) {
	return org.displayName ? `${org.displayName} (@${org.slug})` : `@${org.slug}`
}

export function renderAuthorizeOrgField(input: {
	orgs: ReadonlyArray<OAuthAuthorizeConsentOrg>
	selectedOrgSlug: string | null
	signedIn: boolean
	onSelectedOrgSlugChange?: (slug: string | null) => void
}) {
	const field = oauthAuthorizeOrgField(input)
	switch (field.kind) {
		case 'hidden':
			return (
				<input
					type="hidden"
					name="org"
					value={field.slug}
					data-testid="oauth-authorize-org"
				/>
			)
		case 'picker':
			return (
				<label mix={css(fieldCss)} data-testid="oauth-authorize-org-picker">
					<span mix={css(fieldLabelCss)}>Organization</span>
					<select
						name="org"
						required
						data-testid="oauth-authorize-org"
						mix={[
							css(inputCss),
							input.onSelectedOrgSlugChange
								? on('change', (event) => {
										const target = event.currentTarget
										if (!(target instanceof HTMLSelectElement)) return
										const value = target.value.trim()
										input.onSelectedOrgSlugChange?.(
											value.length > 0 ? value : null,
										)
									})
								: null,
						]}
					>
						{field.selectedSlug ? null : (
							<option value="" disabled selected>
								Choose an organization
							</option>
						)}
						{field.options.map((org) => (
							<option
								key={org.slug}
								value={org.slug}
								selected={org.slug === field.selectedSlug}
							>
								{orgOptionLabel(org)}
							</option>
						))}
					</select>
				</label>
			)
		case 'missing':
			return (
				<p
					role="alert"
					data-testid="oauth-authorize-org-missing"
					mix={css(getAlertCardCss('error'))}
				>
					This account has no organization to bind this connection to.
				</p>
			)
		case 'pending':
			return null
		default: {
			const exhaustive: never = field
			return exhaustive
		}
	}
}

export function renderOauthAuthorizeGrant(input: {
	clientLabel: string
	scopes: ReadonlyArray<string>
	selectedOrgSlug: string | null
}) {
	return (
		<section data-testid="oauth-authorize-grant" mix={css(cardCss)}>
			<h2 mix={css(sectionTitleCss)}>
				{oauthAuthorizeGrantHeading(input.selectedOrgSlug)}
			</h2>
			<p mix={css(descriptionCss)}>
				Approving lets {input.clientLabel} use everything in this Kody
				{input.selectedOrgSlug
					? ` organization @${input.selectedOrgSlug}`
					: ' account'}
				: packages, memories, secrets, email, connected services, and anything
				else your assistant can do.
			</p>
			{input.scopes.length > 0 ? (
				<details
					data-testid="oauth-authorize-oidc-scopes"
					mix={css(nativeDisclosureCss)}
				>
					<summary>Identity claims on the token</summary>
					{/* nativeDisclosureCss grids each direct details child. */}
					<div>
						<p mix={css(descriptionCss)}>
							These OAuth scopes are identity claims. They do not limit what the
							assistant can do.
						</p>
						<p
							mix={css({
								...descriptionCss,
								display: 'flex',
								flexWrap: 'wrap',
								columnGap: spacing.md,
								rowGap: spacing.xs,
								alignItems: 'baseline',
							})}
						>
							{input.scopes.map((scope) => (
								<code key={scope}>{scope}</code>
							))}
						</p>
					</div>
				</details>
			) : null}
		</section>
	)
}

import { css } from 'remix/ui'
import {
	describeMcpOAuthProviderError,
	isMcpOAuthAllowlistRejection,
	type McpOAuthAllowlistFailure,
} from '#universal/mcp-oauth-provider-error.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import { AccountManagementMessage } from '#client/routes/account-management-components.tsx'

const oauthErrorLinkCss = {
	color: colors.primary,
	textUnderlineOffset: '0.15em',
}

export function renderMcpOAuthErrorMessage(input: {
	message: string
	oauthClientOrigin: string
	oauthCallbackUrl: string
	oauthClientMetadataUrl?: string | null
	serverUrl?: string | null
}) {
	if (!isMcpOAuthAllowlistRejection(input.message) || !input.oauthCallbackUrl) {
		return (
			<AccountManagementMessage tone="error">
				{input.message}
			</AccountManagementMessage>
		)
	}

	const described = describeMcpOAuthProviderError(input.message, {
		callbackUrl: input.oauthCallbackUrl,
		clientOrigin: input.oauthClientOrigin,
		clientMetadataUrl: input.oauthClientMetadataUrl,
		serverUrl: input.serverUrl,
	})
	if (described.kind !== 'allowlist') {
		return (
			<AccountManagementMessage tone="error">
				{input.message}
			</AccountManagementMessage>
		)
	}

	return renderMcpOAuthAllowlistCallout(described)
}

function renderMcpOAuthAllowlistCallout(failure: McpOAuthAllowlistFailure) {
	return (
		<section
			role="alert"
			aria-live="assertive"
			mix={css({
				...getAccentCalloutCss({ accentColor: colors.danger }),
				gap: spacing.sm,
			})}
		>
			<p
				mix={css({
					margin: 0,
					color: colors.text,
					fontWeight: typography.fontWeight.semibold,
				})}
			>
				{failure.headline}
			</p>
			<p mix={css({ margin: 0, color: colors.text })}>
				Kody used this callback URL:{' '}
				<code
					mix={css({
						fontFamily: 'monospace',
						fontSize: typography.fontSize.sm,
						overflowWrap: 'anywhere',
					})}
				>
					{failure.callbackUrl}
				</code>
			</p>
			<p mix={css({ margin: 0, color: colors.text })}>
				{failure.vercelDocsUrl && failure.vercelIssueUrl
					? renderVercelAllowlistGuidance({
							vercelDocsUrl: failure.vercelDocsUrl,
							vercelIssueUrl: failure.vercelIssueUrl,
						})
					: failure.guidance}
			</p>
			{failure.providerMessage ? (
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					Provider message: {failure.providerMessage}
				</p>
			) : null}
		</section>
	)
}

function renderVercelAllowlistGuidance(failure: {
	vercelDocsUrl: string
	vercelIssueUrl: string
}) {
	return (
		<>
			Vercel has not approved Kody as an MCP client yet. See{' '}
			<a
				href={failure.vercelDocsUrl}
				target="_blank"
				rel="noreferrer noopener"
				mix={css(oauthErrorLinkCss)}
			>
				Vercel&apos;s supported clients
			</a>{' '}
			and{' '}
			<a
				href={failure.vercelIssueUrl}
				target="_blank"
				rel="noreferrer noopener"
				mix={css(oauthErrorLinkCss)}
			>
				tracking issue 1986
			</a>
			.
		</>
	)
}

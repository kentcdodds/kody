import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { createDoubleCheck } from '#client/double-check.ts'
import { PasswordRevealInput } from '#client/password-reveal-input.tsx'
import { accountInputCss } from '#client/routes/account-management-components.tsx'
import { type McpServerListItem } from '#client/routes/account-mcp-servers-shared.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	type getDangerPillCss,
	type getGhostButtonCss,
	type getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

export type McpServerOAuthClientInput = {
	clientId: string
	clientSecret: string
}

type McpServerOAuthClientSectionProps = {
	server: McpServerListItem
	isMutating: boolean
	primaryButtonCss: ReturnType<typeof getPillButtonCss>
	secondaryButtonCss: ReturnType<typeof getGhostButtonCss>
	dangerButtonCss: ReturnType<typeof getDangerPillCss>
	/** Resolves true once the client is saved. */
	onSave: (client: McpServerOAuthClientInput) => Promise<boolean>
	onRemove: () => void
}

/**
 * The only place a pre-registered OAuth client is set. A saved secret is
 * never sent back to the browser, so a configured client shows as
 * configured with its public id, and can be replaced or removed.
 */
export function McpServerOAuthClientSection(
	handle: Handle<McpServerOAuthClientSectionProps>,
) {
	let editing = false
	let clientIdDraft = ''
	let clientSecretDraft = ''
	const removeCheck = createDoubleCheck(handle)

	function resetDrafts() {
		editing = false
		clientIdDraft = ''
		clientSecretDraft = ''
	}

	return () => {
		const {
			server,
			isMutating,
			primaryButtonCss,
			secondaryButtonCss,
			dangerButtonCss,
			onSave,
			onRemove,
		} = handle.props
		const configured = server.oauthClientId != null
		const showForm = !configured || editing
		const idFieldId = `mcp-oauth-client-id-${server.id}`
		const secretFieldId = `mcp-oauth-client-secret-${server.id}`
		const headingId = `mcp-oauth-client-heading-${server.id}`
		return (
			<section
				data-testid="mcp-server-oauth-client"
				aria-labelledby={headingId}
				mix={css({
					display: 'grid',
					gap: spacing.sm,
					padding: spacing.md,
					borderRadius: radius.md,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.background,
				})}
			>
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<h3 id={headingId} mix={css({ ...fieldLabelCss, margin: 0 })}>
						OAuth client{' '}
						<span mix={css({ color: colors.textMuted })}>(optional)</span>
					</h3>
					<p mix={css({ ...descriptionCss, margin: 0 })}>
						Kody registers itself with most authorization servers on its own.
						Add a client ID and secret only when the server supports neither
						Client ID Metadata Documents nor dynamic client registration (for
						example GitHub), or when you must use a client you registered. Set
						its redirect URI to the OAuth redirect URI shown above.
					</p>
				</div>

				{configured ? (
					<div
						data-testid="mcp-server-oauth-client-configured"
						mix={css({ display: 'grid', gap: spacing.xs })}
					>
						<p
							mix={css({
								margin: 0,
								color: colors.text,
								fontSize: typography.fontSize.sm,
							})}
						>
							<strong>Configured.</strong> Client ID{' '}
							<code
								mix={css({
									fontFamily: 'monospace',
									overflowWrap: 'anywhere',
								})}
							>
								{server.oauthClientId}
							</code>
							. The secret is stored sealed and is not shown again.
						</p>
						{editing ? null : (
							<div
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									flexWrap: 'wrap',
								})}
							>
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', () => {
											editing = true
											clientIdDraft = server.oauthClientId ?? ''
											removeCheck.reset()
											handle.update()
										}),
										css(secondaryButtonCss),
									]}
								>
									Replace
								</button>
								<button
									type="button"
									disabled={isMutating}
									mix={[
										...removeCheck.getButtonMix({
											on: { click: () => onRemove() },
										}),
										css(dangerButtonCss),
									]}
								>
									{removeCheck.doubleCheck
										? 'Confirm remove OAuth client'
										: 'Remove'}
								</button>
							</div>
						)}
					</div>
				) : null}

				{showForm ? (
					<form
						method="post"
						noValidate
						data-testid="mcp-server-oauth-client-form"
						mix={[
							on('submit', async (event) => {
								event.preventDefault()
								const clientSecret = clientSecretDraft.trim()
								clientSecretDraft = ''
								handle.update()
								const saved = await onSave({
									clientId: clientIdDraft.trim(),
									clientSecret,
								})
								if (saved) resetDrafts()
								handle.update()
							}),
							css({ display: 'grid', gap: spacing.sm }),
						]}
					>
						<label for={idFieldId} mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Client ID</span>
							<input
								id={idFieldId}
								data-field-ring
								name="clientId"
								type="text"
								value={clientIdDraft}
								disabled={isMutating}
								required
								autocomplete="off"
								spellcheck={false}
								mix={[
									on('input', (event) => {
										clientIdDraft = event.currentTarget.value
									}),
									css(accountInputCss),
								]}
							/>
						</label>
						<div mix={css(fieldCss)}>
							<label for={secretFieldId} mix={css(fieldLabelCss)}>
								Client secret
							</label>
							<PasswordRevealInput
								id={secretFieldId}
								data-field-ring
								name="clientSecret"
								value={clientSecretDraft}
								disabled={isMutating}
								required
								autocomplete="off"
								data-1p-ignore
								data-lpignore="true"
								revealNoun="client secret"
								mix={[
									on('input', (event) => {
										clientSecretDraft = event.currentTarget.value
									}),
									css(accountInputCss),
								]}
							/>
						</div>
						<div
							mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
						>
							<button
								type="submit"
								disabled={isMutating}
								mix={css(primaryButtonCss)}
							>
								{configured ? 'Replace OAuth client' : 'Save OAuth client'}
							</button>
							{editing ? (
								<button
									type="button"
									disabled={isMutating}
									mix={[
										on('click', () => {
											resetDrafts()
											handle.update()
										}),
										css(secondaryButtonCss),
									]}
								>
									Cancel
								</button>
							) : null}
						</div>
					</form>
				) : null}
			</section>
		)
	}
}

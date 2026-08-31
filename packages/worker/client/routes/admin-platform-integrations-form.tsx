import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type ActionState,
	formatExtraAuthorizeParams,
	formatTokenExchangeStyle,
	joinList,
} from '#client/routes/admin-platform-integrations-shared.ts'
import { type AdminPlatformIntegrationApp } from '#universal/loader-data.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import {
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'

const selectCss = getSelectCss()
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

export function renderIntegrationForm(input: {
	editingApp: AdminPlatformIntegrationApp | null
	formRevision: number
	actionState: ActionState
	pendingSlug: string | null
	removeLogoChecked: boolean
	onSubmit: (event: SubmitEvent) => void
	onLogoFileChange: (event: Event) => void
	onRemoveLogoChange: (checked: boolean) => void
	onToggleEnabled: (app: AdminPlatformIntegrationApp) => void
	onDelete: (app: AdminPlatformIntegrationApp) => void
	onCancel: () => void
}) {
	const {
		editingApp,
		formRevision,
		actionState,
		pendingSlug,
		removeLogoChecked,
	} = input
	const isEditing = editingApp != null
	const formKey =
		isEditing && editingApp
			? `edit-${editingApp.slug}:${formRevision}`
			: `create:${formRevision}`

	return (
		<form
			key={formKey}
			method="post"
			noValidate
			mix={[on('submit', input.onSubmit), css(recordBodyCss)]}
		>
			<div
				mix={css({
					display: 'flex',
					justifyContent: 'space-between',
					gap: spacing.md,
					flexWrap: 'wrap',
					alignItems: 'flex-start',
				})}
			>
				<div mix={css({ display: 'grid', gap: spacing.xs, minWidth: 0 })}>
					<h2 mix={css(cardTitleCss)}>
						{isEditing ? 'Edit integration' : 'Create integration'}
					</h2>
					<p mix={css(descriptionCss)}>
						Save creates or updates a platform OAuth app. Omitted write-only
						fields retain stored values.
					</p>
				</div>
				{isEditing && editingApp ? (
					<div
						mix={css({
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
						})}
					>
						<button
							type="button"
							disabled={actionState !== 'idle'}
							mix={[
								on('click', () => input.onToggleEnabled(editingApp)),
								css(secondaryButtonCss),
							]}
						>
							{actionState === 'toggling-enabled' &&
							pendingSlug === editingApp.slug
								? 'Saving…'
								: editingApp.enabled
									? 'Disable'
									: 'Enable'}
						</button>
						<button
							type="button"
							disabled={actionState !== 'idle'}
							mix={[
								on('click', () => input.onDelete(editingApp)),
								css(dangerButtonCss),
							]}
						>
							{actionState === 'deleting' && pendingSlug === editingApp.slug
								? 'Deleting…'
								: 'Delete'}
						</button>
					</div>
				) : null}
			</div>

			<div mix={css({ display: 'grid', gap: spacing.md })}>
				<div
					mix={css({
						display: 'grid',
						gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
						gap: spacing.md,
						[mq.mobile]: {
							gridTemplateColumns: 'minmax(0, 1fr)',
						},
					})}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>
							Slug
							{isEditing
								? ' (changing it renames in place — secret, logo, and connections carry over)'
								: ''}
						</span>
						<input
							data-field-ring
							name="slug"
							type="text"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.slug ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Provider</span>
						<input
							data-field-ring
							name="provider"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.provider ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Label</span>
						<input
							data-field-ring
							name="label"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.label ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>
							Description (shown to users before they connect)
						</span>
						<textarea
							data-field-ring
							name="description"
							rows={3}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.description ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Client id</span>
						<input
							data-field-ring
							name="clientId"
							type="text"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.clientId ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Client secret</span>
						<input
							data-field-ring
							name="clientSecret"
							type="password"
							autoComplete="new-password"
							placeholder="unchanged when empty"
							disabled={actionState !== 'idle'}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Flow</span>
						<select
							data-field-ring
							name="flow"
							required
							disabled={actionState !== 'idle'}
							mix={css(selectCss)}
						>
							{/* Explicit per-option selection: this renderer applies
							    defaultValue as an attribute, which selects ignore. */}
							<option
								value="pkce"
								selected={(editingApp?.flow ?? 'pkce') === 'pkce'}
							>
								pkce
							</option>
							<option
								value="confidential"
								selected={editingApp?.flow === 'confidential'}
							>
								confidential
							</option>
						</select>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Token exchange style</span>
						<select
							data-field-ring
							name="tokenExchangeStyle"
							disabled={actionState !== 'idle'}
							mix={css(selectCss)}
						>
							{(['default', 'form', 'basic-json', 'basic-form'] as const).map(
								(style) => (
									<option
										key={style}
										value={style}
										selected={
											formatTokenExchangeStyle(
												editingApp?.tokenExchangeStyle ?? null,
											) === style
										}
									>
										{style}
									</option>
								),
							)}
						</select>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Scope separator</span>
						<input
							data-field-ring
							name="scopeSeparator"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.scopeSeparator ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Token URL</span>
						<input
							data-field-ring
							name="tokenUrl"
							type="url"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.tokenUrl ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Authorize URL</span>
						<input
							data-field-ring
							name="authorizeUrl"
							type="url"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.authorizeUrl ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>API base URL</span>
						<input
							data-field-ring
							name="apiBaseUrl"
							type="url"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.apiBaseUrl ?? ''}
							mix={css(accountInputCss)}
						/>
					</label>
				</div>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Allowed scopes</span>
					<input
						data-field-ring
						name="allowedScopes"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.allowedScopes ?? [])}
						mix={css(accountInputCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Default scopes</span>
					<input
						data-field-ring
						name="defaultScopes"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.defaultScopes ?? [])}
						mix={css(accountInputCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Required hosts</span>
					<input
						data-field-ring
						name="requiredHosts"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.requiredHosts ?? [])}
						mix={css(accountInputCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Extra authorize params</span>
					<textarea
						data-field-ring
						name="extraAuthorizeParams"
						disabled={actionState !== 'idle'}
						placeholder="key=value (one per line)"
						defaultValue={formatExtraAuthorizeParams(
							editingApp?.extraAuthorizeParams ?? {},
						)}
						mix={css(accountTextareaCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Logo</span>
					<input
						data-field-ring
						name="logo"
						type="file"
						accept="image/svg+xml,image/png,image/jpeg,image/webp"
						disabled={actionState !== 'idle'}
						mix={[on('change', input.onLogoFileChange), css(accountInputCss)]}
					/>
				</label>
				{isEditing && editingApp?.logoPath ? (
					<div
						mix={css({
							display: 'flex',
							alignItems: 'center',
							gap: spacing.md,
							flexWrap: 'wrap',
						})}
					>
						<span mix={css(getLogoWellCss({ size: '2.5rem', radius: '10px' }))}>
							<img
								src={editingApp.logoPath}
								alt=""
								width={32}
								height={32}
								mix={css({
									display: 'block',
									width: '1.75rem',
									height: '1.75rem',
									objectFit: 'contain',
								})}
							/>
						</span>
						<label
							mix={css({
								...fieldCss,
								display: 'flex',
								flexDirection: 'row',
								alignItems: 'center',
								gap: spacing.sm,
							})}
						>
							<input
								name="removeLogo"
								type="checkbox"
								checked={removeLogoChecked}
								disabled={actionState !== 'idle'}
								mix={[
									css({
										width: '1.25rem',
										height: '1.25rem',
										accentColor: colors.primary,
									}),
									on('change', (event) => {
										const checkbox = event.currentTarget
										if (!(checkbox instanceof HTMLInputElement)) return
										input.onRemoveLogoChange(checkbox.checked)
									}),
								]}
							/>
							<span mix={css(fieldLabelCss)}>Remove logo</span>
						</label>
					</div>
				) : null}
				<label
					mix={css({
						...fieldCss,
						display: 'flex',
						flexDirection: 'row',
						alignItems: 'center',
						gap: spacing.sm,
					})}
				>
					<input
						name="enabled"
						type="checkbox"
						defaultChecked={editingApp?.enabled ?? true}
						disabled={actionState !== 'idle'}
						mix={css({
							width: '1.25rem',
							height: '1.25rem',
							accentColor: colors.primary,
						})}
					/>
					<span mix={css(fieldLabelCss)}>Enabled</span>
				</label>
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					})}
				>
					<button
						type="submit"
						disabled={actionState !== 'idle'}
						mix={css(primaryButtonCss)}
					>
						{actionState === 'saving-form'
							? 'Saving…'
							: isEditing
								? 'Save changes'
								: 'Create integration'}
					</button>
					{isEditing ? (
						<button
							type="button"
							disabled={actionState !== 'idle'}
							mix={[on('click', input.onCancel), css(secondaryButtonCss)]}
						>
							Cancel edit
						</button>
					) : (
						<button
							type="button"
							disabled={actionState !== 'idle'}
							mix={[on('click', input.onCancel), css(secondaryButtonCss)]}
						>
							Cancel
						</button>
					)}
				</div>
			</div>
		</form>
	)
}

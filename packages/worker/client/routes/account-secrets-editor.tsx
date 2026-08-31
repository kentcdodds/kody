import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { type AccountSecretDetail } from '#universal/loader-data.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import { Combobox } from '#client/combobox.tsx'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { SecretEditorFields } from './secret-editor-fields.tsx'
import {
	MetadataGrid,
	TimestampValue,
	accountInputCss,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import { secretPackageIdentityCss } from './account-secrets-approval.tsx'
import {
	type EditorState,
	type SecretScope,
	formatRelativeTtl,
} from './account-secrets-shared.ts'

const selectCss = getSelectCss()

export type SecretEditorProps = {
	isCreating: boolean
	selectedSecret: AccountSecretDetail | null
	editorState: EditorState
	setEditorState: (next: EditorState) => void
	packageOptions: Array<{ id: string }>
	packageSelectOptions: Array<{
		id: string
		label: string
		description: string
	}>
	availableAllowedPackageOptions: Array<{
		id: string
		label: string
		description: string
	}>
	packagesById: ReadonlyMap<string, { kodyId: string; name: string }>
	canCreatePackageSecrets: boolean
	isMutating: boolean
	saveState: 'idle' | 'saving' | 'deleting'
	showSecretValue: boolean
	onToggleShowSecretValue: () => void
	secretValueAutofocusKey: string
	deleteSecretCheck: ReturnType<typeof createDoubleCheck>
	onSave: (event: SubmitEvent) => void
	onDelete: () => void
	updateAllowedHost: (index: number, value: string) => void
	addAllowedHost: () => void
	removeAllowedHost: (index: number) => void
	addAllowedPackage: (packageId: string) => void
	removeAllowedPackage: (packageId: string) => void
}

export function renderSecretEditor(props: SecretEditorProps) {
	const {
		isCreating,
		selectedSecret,
		editorState,
		setEditorState,
		packageOptions,
		packageSelectOptions,
		availableAllowedPackageOptions,
		packagesById,
		canCreatePackageSecrets,
		isMutating,
		saveState,
		showSecretValue,
		onToggleShowSecretValue,
		secretValueAutofocusKey,
		deleteSecretCheck,
		onSave,
		onDelete,
		updateAllowedHost,
		addAllowedHost,
		removeAllowedHost,
		addAllowedPackage,
		removeAllowedPackage,
	} = props
	return (
		<form
			{...passwordManagerIgnoreProps}
			mix={[css(recordBodyCss), on('submit', onSave)]}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2
					mix={css({
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					})}
				>
					{isCreating ? 'New secret' : selectedSecret?.name}
				</h2>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					{isCreating
						? 'Create a new user or package secret.'
						: 'Update the secret value and metadata for this entry.'}
				</p>
			</div>

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
					<span mix={css(fieldLabelCss)}>Name</span>
					<input
						data-field-ring
						type="text"
						required
						value={editorState.name}
						placeholder="api-token"
						mix={[
							on('input', (event) => {
								setEditorState({
									...editorState,
									name: event.currentTarget.value,
								})
							}),

							css(accountInputCss),
						]}
					/>
				</label>

				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Scope</span>
					<select
						data-field-ring
						value={editorState.scope}
						mix={[
							on('change', (event) => {
								const scope = event.currentTarget.value as SecretScope
								setEditorState({
									...editorState,
									scope,
									packageId:
										scope === 'package'
											? editorState.packageId || packageOptions[0]?.id || ''
											: '',
								})
							}),

							css(selectCss),
						]}
					>
						<option value="user">User</option>
						{canCreatePackageSecrets ? (
							<option value="package">Package</option>
						) : null}
					</select>
				</label>
			</div>

			{editorState.scope === 'package' ? (
				<Combobox
					key={`secret-editor-package:${editorState.packageId}`}
					id="secret-editor-package"
					label="Package"
					placeholder="Choose a package"
					value={editorState.packageId}
					options={packageSelectOptions}
					onChange={(packageId) => {
						setEditorState({
							...editorState,
							packageId,
						})
					}}
				/>
			) : null}

			<SecretEditorFields
				autoFocusKey={secretValueAutofocusKey}
				description={editorState.description}
				onDescriptionChange={(description) => {
					setEditorState({
						...editorState,
						description,
					})
				}}
				expiresAt={editorState.expiresAt}
				onExpiresAtChange={(expiresAt) => {
					setEditorState({
						...editorState,
						expiresAt,
					})
				}}
				value={editorState.value}
				onValueChange={(value) => {
					setEditorState({
						...editorState,
						value,
					})
				}}
				showSecretValue={showSecretValue}
				onToggleShowSecretValue={onToggleShowSecretValue}
				allowedHosts={editorState.allowedHosts}
				onUpdateAllowedHost={updateAllowedHost}
				onAddAllowedHost={addAllowedHost}
				onRemoveAllowedHost={removeAllowedHost}
				allowedHostsListName="allowed-hosts"
			/>

			{editorState.scope === 'user' ? (
				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<span mix={css(fieldLabelCss)}>Allowed packages</span>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Only selected packages may access this user secret from package
							runtimes.
						</p>
					</div>
					{editorState.allowedPackages.length > 0 ? (
						<div mix={css({ display: 'grid', gap: spacing.sm })}>
							{editorState.allowedPackages.map((packageId) => {
								const metadata = packagesById.get(packageId)
								const packageLabel = metadata?.kodyId ?? 'Unknown package'
								return (
									<div
										key={packageId}
										mix={css({
											display: 'grid',
											gridTemplateColumns: 'minmax(0, 1fr) auto',
											gap: spacing.sm,
											alignItems: 'center',
											padding: spacing.sm,
											border: `1px solid ${colors.border}`,
											borderRadius: radius.md,
										})}
									>
										<span mix={css(secretPackageIdentityCss)}>
											<strong>{packageLabel}</strong>
											<code>{packageId}</code>
										</span>
										<button
											type="button"
											aria-label={`Remove package ${packageLabel}`}
											mix={[
												on('click', () => removeAllowedPackage(packageId)),

												css(secondaryButtonCss),
											]}
										>
											Remove
										</button>
									</div>
								)
							})}
						</div>
					) : (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							No packages currently have access.
						</p>
					)}
					{availableAllowedPackageOptions.length > 0 ? (
						<Combobox
							key={`allowed-package-picker:${editorState.allowedPackages.join(',')}`}
							id="secret-allowed-package"
							label="Add allowed package"
							placeholder="Search saved packages"
							value=""
							options={availableAllowedPackageOptions}
							onChange={addAllowedPackage}
						/>
					) : packageOptions.length > 0 ? (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							All saved packages are already allowed.
						</p>
					) : null}
				</div>
			) : null}

			{selectedSecret ? (
				<MetadataGrid
					items={[
						{
							label: 'Created',
							value: <TimestampValue value={selectedSecret.createdAt} />,
						},
						{
							label: 'Updated',
							value: <TimestampValue value={selectedSecret.updatedAt} />,
						},
						{
							label: 'Expiry',
							value: formatRelativeTtl(selectedSecret.ttlMs),
						},
					]}
				/>
			) : null}

			<div
				mix={css({
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
				})}
			>
				<button
					type="submit"
					disabled={
						isMutating ||
						(editorState.scope === 'package' && !editorState.packageId)
					}
					mix={css(primaryButtonCss)}
				>
					{saveState === 'saving' ? 'Saving...' : 'Save'}
				</button>
				{editorState.currentId ? (
					<button
						type="button"
						disabled={isMutating}
						aria-label={
							deleteSecretCheck.doubleCheck
								? `Confirm delete secret "${editorState.name}"`
								: `Delete secret "${editorState.name}"`
						}
						title={
							deleteSecretCheck.doubleCheck
								? `Click again to delete "${editorState.name}"`
								: `Delete secret "${editorState.name}"`
						}
						mix={[
							...deleteSecretCheck.getButtonMix({
								on: {
									click: onDelete,
								},
							}),
							css(dangerButtonCss),
						]}
					>
						{saveState === 'deleting'
							? 'Deleting...'
							: deleteSecretCheck.doubleCheck
								? 'Confirm delete'
								: 'Delete'}
					</button>
				) : null}
			</div>
		</form>
	)
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

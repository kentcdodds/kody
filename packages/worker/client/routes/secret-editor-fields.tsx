import { type Handle, css, ref } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { accountDisclosureCss } from './account-management-components.tsx'
import {
	fieldCss,
	fieldLabelCss,
	getSecondaryButtonCss,
	inputCss,
	textareaCss,
} from '#universal/styles/style-primitives.ts'

type SecretEditorFieldsProps = {
	autoFocusKey?: string
	description: string
	onDescriptionChange: (value: string) => void
	value: string
	onValueChange: (value: string) => void
	showSecretValue: boolean
	onToggleShowSecretValue: () => void
	allowedHosts: Array<string>
	onUpdateAllowedHost: (index: number, value: string) => void
	onAddAllowedHost: () => void
	onRemoveAllowedHost: (index: number) => void
	allowedCapabilities: Array<string>
	onUpdateAllowedCapability: (index: number, value: string) => void
	onAddAllowedCapability: () => void
	onRemoveAllowedCapability: (index: number) => void
	valuePlaceholder?: string
	allowedHostsListName?: string
	allowedCapabilitiesListName?: string
}

function focusSecretValueInput(root: Element) {
	const input = root.querySelector('input[data-field="secret-value"]')
	if (!(input instanceof HTMLInputElement)) return false
	input.focus({ preventScroll: true })
	input.scrollIntoView({ block: 'center', inline: 'nearest' })
	return true
}

export function SecretEditorFields(handle: Handle<SecretEditorFieldsProps>) {
	let valueField: HTMLElement | null = null
	let focusedForKey: string | null = null

	return () => {
		const props = handle.props
		const autoFocusKey = props.autoFocusKey ?? ''
		if (!autoFocusKey) {
			focusedForKey = null
		} else if (focusedForKey !== autoFocusKey) {
			handle.queueTask((signal) => {
				if (signal.aborted || focusedForKey === autoFocusKey || !valueField) {
					return
				}
				if (focusSecretValueInput(valueField)) {
					focusedForKey = autoFocusKey
				}
			})
		}
		return (
			<>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Description</span>
					<textarea
						value={props.description}
						rows={3}
						placeholder="What this secret is used for"
						mix={[
							on(
								'input',

								(event) => {
									props.onDescriptionChange(event.currentTarget.value)
								},
							),

							css(textareaCss),
						]}
					/>
				</label>

				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Secret value</span>
					<div
						mix={[
							css({
								position: 'relative',
								display: 'flex',
								alignItems: 'center',
							}),
							ref((node, signal) => {
								valueField = node as HTMLElement
								signal.addEventListener('abort', () => {
									if (valueField === node) valueField = null
								})
								if (
									autoFocusKey &&
									focusedForKey !== autoFocusKey &&
									focusSecretValueInput(node)
								) {
									focusedForKey = autoFocusKey
								}
							}),
						]}
					>
						{props.showSecretValue ? (
							<input
								type="text"
								required
								autoFocus={Boolean(autoFocusKey)}
								data-field="secret-value"
								{...passwordManagerIgnoreProps}
								value={props.value}
								placeholder={props.valuePlaceholder ?? 'Enter the secret value'}
								mix={[
									on(
										'input',

										(event) => {
											props.onValueChange(event.currentTarget.value)
										},
									),

									css({
										...inputCss,
										paddingRight: '4.5rem',
									}),
								]}
							/>
						) : (
							<input
								type="password"
								required
								autoFocus={Boolean(autoFocusKey)}
								data-field="secret-value"
								{...passwordManagerIgnoreProps}
								value={props.value}
								placeholder={props.valuePlaceholder ?? 'Enter the secret value'}
								mix={[
									on(
										'input',

										(event) => {
											props.onValueChange(event.currentTarget.value)
										},
									),

									css({
										...inputCss,
										paddingRight: '4.5rem',
									}),
								]}
							/>
						)}
						<button
							type="button"
							aria-label={
								props.showSecretValue
									? 'Hide secret value'
									: 'Show secret value'
							}
							title={
								props.showSecretValue
									? 'Hide secret value'
									: 'Show secret value'
							}
							mix={[
								on('click', () => props.onToggleShowSecretValue()),
								css(iconButtonCss),
							]}
						>
							{props.showSecretValue ? 'Hide' : 'Show'}
						</button>
					</div>
				</label>

				<details
					mix={css(advancedDetailsCss)}
					data-testid="secret-editor-advanced"
				>
					<summary>Advanced details</summary>
					<div mix={css({ display: 'grid', gap: spacing.lg })}>
						<div mix={css({ display: 'grid', gap: spacing.sm })}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<span mix={css(fieldLabelCss)}>
									Where this secret can be sent
								</span>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Leave this empty to ask before Kody sends this secret to a
									site.
								</p>
							</div>
							<div
								data-repeat-list={props.allowedHostsListName}
								mix={css({ display: 'grid', gap: spacing.sm })}
							>
								{props.allowedHosts.map((host, index) => (
									<div key={index} mix={css(repeatedRowCss)}>
										<input
											type="text"
											value={typeof host === 'string' ? host : ''}
											placeholder="api.example.com"
											mix={[
												on(
													'input',

													(event) => {
														props.onUpdateAllowedHost(
															index,
															event.currentTarget.value,
														)
													},
												),

												css(inputCss),
											]}
										/>

										<button
											type="button"
											mix={[
												on('click', () => props.onRemoveAllowedHost(index)),
												css(secondaryButtonCss),
											]}
										>
											Remove
										</button>
									</div>
								))}
							</div>
							<div>
								<button
									type="button"
									mix={[
										on('click', () => props.onAddAllowedHost()),
										css(secondaryButtonCss),
									]}
								>
									Add host
								</button>
							</div>
						</div>

						<div mix={css({ display: 'grid', gap: spacing.sm })}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<span mix={css(fieldLabelCss)}>
									Which tools can use this secret
								</span>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Leave this empty to let any tool use this secret. Add names
									here to restrict it.
								</p>
							</div>
							<div
								data-repeat-list={props.allowedCapabilitiesListName}
								mix={css({ display: 'grid', gap: spacing.sm })}
							>
								{props.allowedCapabilities.map((capabilityName, index) => (
									<div key={index} mix={css(repeatedRowCss)}>
										<input
											type="text"
											value={
												typeof capabilityName === 'string' ? capabilityName : ''
											}
											placeholder="home_lutron_set_credentials"
											mix={[
												on(
													'input',

													(event) => {
														props.onUpdateAllowedCapability(
															index,
															event.currentTarget.value,
														)
													},
												),

												css(inputCss),
											]}
										/>

										<button
											type="button"
											mix={[
												on('click', () =>
													props.onRemoveAllowedCapability(index),
												),
												css(secondaryButtonCss),
											]}
										>
											Remove
										</button>
									</div>
								))}
							</div>
							<div>
								<button
									type="button"
									mix={[
										on('click', () => props.onAddAllowedCapability()),
										css(secondaryButtonCss),
									]}
								>
									Add capability
								</button>
							</div>
						</div>
					</div>
				</details>
			</>
		)
	}
}

const secondaryButtonCss = getSecondaryButtonCss()

const advancedDetailsCss = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const iconButtonCss = {
	position: 'absolute' as const,
	right: spacing.sm,
	top: '50%',
	transform: 'translateY(-50%)',
	background: 'none',
	border: 'none',
	borderRadius: '999px',
	padding: spacing.xs,
	width: '3.5rem',
	height: '2rem',
	color: colors.text,
	cursor: 'pointer',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontSize: '0.75rem',
	fontWeight: 600,
	'&:hover': {
		background: colors.primarySoft,
	},
}

const repeatedRowCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	gap: spacing.sm,
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
}

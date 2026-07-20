import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { colors, mq, spacing } from '#client/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getSecondaryButtonCss,
	inputCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'

type SecretEditorFieldsProps = {
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

export function SecretEditorFields(handle: Handle<SecretEditorFieldsProps>) {
	return () => {
		const props = handle.props
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
						mix={css({
							position: 'relative',
							display: 'flex',
							alignItems: 'center',
						})}
					>
						{props.showSecretValue ? (
							<input
								type="text"
								required
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

				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<span mix={css(fieldLabelCss)}>Allowed hosts</span>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Leave this empty to require explicit host approval before a secret
							can be used.
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
						<span mix={css(fieldLabelCss)}>Allowed capabilities</span>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Only capabilities listed here can resolve this secret when used
							with an <code>x-kody-secret</code> input.
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
										on('click', () => props.onRemoveAllowedCapability(index)),
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
			</>
		)
	}
}

const secondaryButtonCss = getSecondaryButtonCss()

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

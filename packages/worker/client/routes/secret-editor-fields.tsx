import { type Handle } from 'remix/component'
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

export function SecretEditorFields(_handle: Handle) {
	return (props: SecretEditorFieldsProps) => (
		<>
			<label css={fieldCss}>
				<span css={fieldLabelCss}>Description</span>
				<textarea
					value={props.description}
					rows={3}
					placeholder="What this secret is used for"
					on={{
						input: (event) => {
							props.onDescriptionChange(event.currentTarget.value)
						},
					}}
					css={textareaCss}
				/>
			</label>

			<label css={fieldCss}>
				<span css={fieldLabelCss}>Secret value</span>
				<div
					css={{
						position: 'relative',
						display: 'flex',
						alignItems: 'center',
					}}
				>
					{props.showSecretValue ? (
						<input
							type="text"
							required
							autoComplete="new-password"
							value={props.value}
							placeholder={props.valuePlaceholder ?? 'Enter the secret value'}
							on={{
								input: (event) => {
									props.onValueChange(event.currentTarget.value)
								},
							}}
							css={{
								...inputCss,
								paddingRight: '3rem',
							}}
						/>
					) : (
						<input
							type="password"
							required
							autoComplete="new-password"
							value={props.value}
							placeholder={props.valuePlaceholder ?? 'Enter the secret value'}
							on={{
								input: (event) => {
									props.onValueChange(event.currentTarget.value)
								},
							}}
							css={{
								...inputCss,
								paddingRight: '3rem',
							}}
						/>
					)}
					<button
						type="button"
						aria-label={
							props.showSecretValue ? 'Hide secret value' : 'Show secret value'
						}
						title={
							props.showSecretValue ? 'Hide secret value' : 'Show secret value'
						}
						on={{ click: () => props.onToggleShowSecretValue() }}
						css={iconButtonCss}
					>
						{props.showSecretValue ? (
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
								<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
								<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
								<line x1="2" x2="22" y1="2" y2="22" />
							</svg>
						) : (
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
						)}
					</button>
				</div>
			</label>

			<div css={{ display: 'grid', gap: spacing.sm }}>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<span css={fieldLabelCss}>Allowed hosts</span>
					<p css={{ margin: 0, color: colors.textMuted }}>
						Leave this empty to require explicit host approval before a secret
						can be used.
					</p>
				</div>
				<div
					css={{ display: 'grid', gap: spacing.sm }}
					data-repeat-list={props.allowedHostsListName}
				>
					{props.allowedHosts.map((host, index) => (
						<div key={index} css={repeatedRowCss}>
							<input
								type="text"
								value={typeof host === 'string' ? host : ''}
								placeholder="api.example.com"
								on={{
									input: (event) => {
										props.onUpdateAllowedHost(index, event.currentTarget.value)
									},
								}}
								css={inputCss}
							/>
							<button
								type="button"
								on={{ click: () => props.onRemoveAllowedHost(index) }}
								css={secondaryButtonCss}
							>
								Remove
							</button>
						</div>
					))}
				</div>
				<div>
					<button
						type="button"
						on={{ click: () => props.onAddAllowedHost() }}
						css={secondaryButtonCss}
					>
						Add host
					</button>
				</div>
			</div>

			<div css={{ display: 'grid', gap: spacing.sm }}>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<span css={fieldLabelCss}>Allowed capabilities</span>
					<p css={{ margin: 0, color: colors.textMuted }}>
						Only capabilities listed here can resolve this secret when used with
						an <code>x-kody-secret</code> input.
					</p>
				</div>
				<div
					css={{ display: 'grid', gap: spacing.sm }}
					data-repeat-list={props.allowedCapabilitiesListName}
				>
					{props.allowedCapabilities.map((capabilityName, index) => (
						<div key={index} css={repeatedRowCss}>
							<input
								type="text"
								value={typeof capabilityName === 'string' ? capabilityName : ''}
								placeholder="home_lutron_set_credentials"
								on={{
									input: (event) => {
										props.onUpdateAllowedCapability(
											index,
											event.currentTarget.value,
										)
									},
								}}
								css={inputCss}
							/>
							<button
								type="button"
								on={{ click: () => props.onRemoveAllowedCapability(index) }}
								css={secondaryButtonCss}
							>
								Remove
							</button>
						</div>
					))}
				</div>
				<div>
					<button
						type="button"
						on={{ click: () => props.onAddAllowedCapability() }}
						css={secondaryButtonCss}
					>
						Add capability
					</button>
				</div>
			</div>
		</>
	)
}

const secondaryButtonCss = getSecondaryButtonCss()

const iconButtonCss = {
	position: 'absolute' as const,
	right: spacing.sm,
	background: 'none',
	border: 'none',
	padding: 0,
	color: colors.textMuted,
	cursor: 'pointer',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	'&:hover': {
		color: colors.text,
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

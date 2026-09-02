import { type Handle, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import {
	isSignupMode,
	type SignupMode,
	type SignupModeSetting,
	signupModes,
} from '#universal/signup-mode.ts'
import {
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { mq, spacing } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'

const selectCss = getSelectCss()
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })
const retryButtonCss = getGhostButtonCss({ size: 'sm' })

const signupModeLabels: Record<SignupMode, string> = {
	invite: 'Invite',
	open: 'Open',
	waitlist: 'Waitlist',
}

export function createAdminInvitesSignupModePanel(handle: Handle) {
	const openModeCheck = createDoubleCheck(handle)
	let selectedMode: SignupMode | null = null
	let lastAppliedMode: SignupMode | null = null

	function syncFromSetting(setting: SignupModeSetting | null) {
		if (!setting) {
			selectedMode = null
			lastAppliedMode = null
			openModeCheck.reset()
			return
		}
		if (lastAppliedMode !== setting.mode) {
			selectedMode = setting.mode
			lastAppliedMode = setting.mode
			openModeCheck.reset()
		}
	}

	function render(input: {
		setting: SignupModeSetting | null
		disabled: boolean
		saving: boolean
		onSave: (mode: SignupMode, expectedCurrentMode: SignupMode) => void
		onRetry?: () => void
	}) {
		syncFromSetting(input.setting)
		const setting = input.setting
		const loaded = setting != null
		const controlsDisabled = input.disabled || !loaded
		const switchingToOpen =
			loaded && selectedMode === 'open' && setting.mode !== 'open'
		const unchanged = !loaded || selectedMode === setting.mode

		return (
			<AccountManagementPanel
				title="Signup mode"
				description="Invite, open, or waitlist. Invites only matter in invite mode. Open signup requires Turnstile bot defence."
			>
				<div
					mix={css({
						display: 'grid',
						gridTemplateColumns: 'minmax(0, 1fr) auto',
						gap: spacing.md,
						alignItems: 'end',
						[mq.mobile]: {
							gridTemplateColumns: 'minmax(0, 1fr)',
							alignItems: 'stretch',
						},
					})}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Mode</span>
						<select
							data-field-ring
							value={selectedMode ?? ''}
							disabled={controlsDisabled}
							mix={[
								css(selectCss),
								on('change', (event) => {
									if (!(event.currentTarget instanceof HTMLSelectElement)) {
										return
									}
									const next = event.currentTarget.value
									if (isSignupMode(next)) {
										selectedMode = next
										openModeCheck.reset()
										handle.update()
									}
								}),
							]}
						>
							{selectedMode == null ? (
								<option value="" disabled>
									Loading…
								</option>
							) : null}
							{signupModes.map((mode) => (
								<option key={mode} value={mode}>
									{signupModeLabels[mode]}
								</option>
							))}
						</select>
					</label>
					{input.onRetry && !loaded ? (
						<button
							type="button"
							mix={[
								css(retryButtonCss),
								on('click', () => {
									input.onRetry?.()
								}),
							]}
						>
							Retry
						</button>
					) : (
						<button
							type="button"
							disabled={controlsDisabled || unchanged}
							mix={[
								css(switchingToOpen ? dangerButtonCss : primaryButtonCss),
								...(switchingToOpen
									? openModeCheck.getButtonMix({
											on: {
												click: () => {
													if (selectedMode == null || setting == null) return
													input.onSave(selectedMode, setting.mode)
												},
											},
										})
									: [
											on('click', () => {
												if (selectedMode == null || setting == null) return
												input.onSave(selectedMode, setting.mode)
											}),
										]),
							]}
						>
							{input.saving
								? 'Saving…'
								: switchingToOpen && openModeCheck.doubleCheck
									? 'Click again to open signup'
									: 'Save mode'}
						</button>
					)}
				</div>
				{setting ? (
					<MetadataGrid
						items={[
							{
								label: 'Source',
								value:
									setting.source === 'kv'
										? 'KV override'
										: `env default (${setting.envDefault})`,
							},
							{
								label: 'Last changed',
								value: (
									<TimestampValue value={setting.updatedAt} fallback="Never" />
								),
							},
							{
								label: 'Changed by',
								value: setting.updatedBy ? (
									<IdValue value={setting.updatedBy} label="updated by" />
								) : (
									'—'
								),
							},
						]}
					/>
				) : null}
			</AccountManagementPanel>
		)
	}

	return { render }
}

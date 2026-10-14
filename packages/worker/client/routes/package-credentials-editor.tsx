import { type Handle, type RemixNode, css } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import {
	type CredentialMappingTarget,
	type PackageCredentialsView,
	type PackageCredentialsWriteError,
} from '#universal/credential-contracts.ts'
import { credentialRefLabel } from '#universal/package-credentials-page.ts'
import {
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	type MappingDraft,
	describeMappingTarget,
	draftFromStored,
	draftToChange,
	mappingEditorKey,
	mappingOptions,
	mappingSaveAgentPrompt,
	postPackageCredentialChanges,
	toggleDraftPick,
	triggerDraftProblem,
	triggerWillEnable,
} from './package-credentials-editing.ts'
import {
	type MappingCellInput,
	renderStored,
} from './package-credentials-tabs.tsx'

const primaryButtonCss = getPrimaryButtonCss({ weight: 'semibold' })
const secondaryButtonCss = getSecondaryButtonCss({ weight: 'semibold' })
const linkButtonCss = {
	padding: 0,
	border: 'none',
	background: 'none',
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	textDecoration: 'underline',
	cursor: 'pointer',
}
const optionCss = {
	display: 'flex',
	gap: spacing.xs,
	alignItems: 'baseline',
	fontSize: typography.fontSize.sm,
}

type EditorMessage = {
	text: string
	createUrl?: string
}

type OpenEditor = {
	key: string
	target: CredentialMappingTarget
	needKey: string
	draft: MappingDraft
	saving: boolean
	messages: Array<EditorMessage>
}

function writeErrorMessages(
	errors: ReadonlyArray<PackageCredentialsWriteError>,
): Array<EditorMessage> {
	return errors.map((error) => ({
		text: error.message,
		createUrl: error.createUrl,
	}))
}

/**
 * Inline editing for one mapping at a time. A save posts one change and,
 * on success, hands the refreshed view back to the page.
 */
export function createPackageMappingEditor(
	handle: Handle,
	options: {
		readPage: () => { username: string; kodyId: string; orgSlug: string }
		onSaved: (
			view: PackageCredentialsView,
			postedTo: { username: string; kodyId: string },
		) => void
	},
) {
	let open: OpenEditor | null = null
	let session = 0

	function update(next: Partial<OpenEditor>) {
		if (!open) return
		open = { ...open, ...next }
		handle.update()
	}

	function openEditor(next: OpenEditor | null) {
		session += 1
		open = next
	}

	async function save(input: MappingCellInput) {
		if (!open || open.saving) return
		const unchanged = triggerDraftProblem(input.trigger, open.draft)
		if (unchanged) {
			update({ messages: [{ text: unchanged }] })
			return
		}
		const planned = draftToChange({
			target: input.target,
			need: input.need,
			draft: open.draft,
		})
		if (!planned.ok) {
			update({ messages: [{ text: planned.error }] })
			return
		}
		update({ saving: true, messages: [] })
		const started = session
		const page = options.readPage()
		const result = await postPackageCredentialChanges({
			username: page.username,
			kodyId: page.kodyId,
			changes: [planned.change],
		})
		if (result.kind === 'saved') options.onSaved(result.view, page)
		// The editor was closed or replaced (a tab change resets it) while
		// the write was in flight; its outcome belongs to that old form.
		if (session !== started) return
		switch (result.kind) {
			case 'saved':
				openEditor(null)
				handle.update()
				return
			case 'refused':
				update({ saving: false, messages: writeErrorMessages(result.errors) })
				return
			case 'error':
				update({ saving: false, messages: [{ text: result.message }] })
				return
			case 'unauthorized':
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(window.location.pathname)}`,
				)
				return
			default: {
				const exhaustive: never = result
				return exhaustive
			}
		}
	}

	function renderMessages(input: MappingCellInput, state: OpenEditor) {
		if (state.messages.length === 0) return null
		const pageUrl = typeof window === 'undefined' ? '' : window.location.href
		return (
			<div
				role="alert"
				data-testid="package-mapping-error"
				mix={css({ display: 'grid', gap: spacing.xs, justifyItems: 'start' })}
			>
				{state.messages.map((message) => (
					<p key={message.text} mix={css({ margin: 0, color: colors.danger })}>
						{message.text}
						{message.createUrl ? (
							<>
								{' '}
								<a href={message.createUrl}>Add a credential</a>
							</>
						) : null}
					</p>
				))}
				<CopyTextButton
					value={mappingSaveAgentPrompt({
						pageUrl,
						needKey: input.need.key,
						target: input.target,
						message: state.messages.map((message) => message.text).join(' '),
					})}
					idleLabel="Copy prompt for your agent"
				/>
			</div>
		)
	}

	function renderForm(input: MappingCellInput, state: OpenEditor): RemixNode {
		const choices = mappingOptions(input.need, input.target)
		const group = `mapping-${state.key}`
		const multiple = input.need.multiple
		const draft = state.draft
		const radio = (mode: 'inherit' | 'none', label: string) => (
			<label mix={css(optionCss)}>
				<input
					type="radio"
					name={group}
					value={mode}
					checked={draft.mode === mode}
					disabled={state.saving}
					mix={on('change', () => update({ draft: { mode }, messages: [] }))}
				/>
				<span>{label}</span>
			</label>
		)
		return (
			<form
				data-testid="package-mapping-editor"
				mix={[
					css({ display: 'grid', gap: spacing.sm }),
					on('submit', (event) => {
						event.preventDefault()
						void save(input)
					}),
				]}
			>
				<fieldset
					mix={css({
						margin: 0,
						padding: 0,
						border: 'none',
						display: 'grid',
						gap: spacing.xs,
					})}
				>
					<legend mix={css({ padding: 0, fontSize: typography.fontSize.sm })}>
						{multiple
							? `Credentials for ${input.need.key}`
							: `Credential for ${input.need.key}`}
					</legend>
					{choices.map((choice) => (
						<label key={choice.id} mix={css(optionCss)}>
							<input
								type={multiple ? 'checkbox' : 'radio'}
								name={group}
								value={choice.id}
								checked={draft.mode === 'pick' && draft.ids.includes(choice.id)}
								disabled={state.saving}
								mix={on('change', (event) =>
									update({
										draft: toggleDraftPick(draft, choice.id, {
											multiple,
											checked: event.currentTarget.checked,
										}),
										messages: [],
									}),
								)}
							/>
							<span>{credentialRefLabel(choice)}</span>
						</label>
					))}
					{choices.length === 0 ? (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							No credential you can map matches this need.{' '}
							<a href={input.need.createUrl}>Add a credential</a>
						</p>
					) : null}
					{radio('none', 'None on purpose (runs get no credential)')}
					{radio('inherit', input.inheritLabel)}
				</fieldset>
				{input.trigger && triggerWillEnable(input.trigger, draft) ? (
					<p mix={css({ margin: 0, color: colors.warningText })}>
						Saving turns this trigger on for you.
					</p>
				) : null}
				{input.stored && input.stored.unusableIds.length > 0 ? (
					<p
						mix={css({ margin: 0, color: colors.warningText })}
						data-testid="package-mapping-drops-unusable"
					>
						{input.stored.unusableIds.length === 1
							? 'Saving replaces this mapping and drops the credential you can no longer use.'
							: `Saving replaces this mapping and drops the ${input.stored.unusableIds.length} credentials you can no longer use.`}
					</p>
				) : null}
				{renderMessages(input, state)}
				<div mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}>
					<button
						type="submit"
						disabled={state.saving}
						data-testid="package-mapping-save"
						mix={css(primaryButtonCss)}
					>
						{state.saving ? 'Saving…' : 'Save mapping'}
					</button>
					<button
						type="button"
						disabled={state.saving}
						mix={[
							css(secondaryButtonCss),
							on('click', () => {
								openEditor(null)
								handle.update()
							}),
						]}
					>
						Cancel
					</button>
				</div>
			</form>
		)
	}

	function renderCell(input: MappingCellInput): RemixNode {
		const key = mappingEditorKey(input.target, input.need.key)
		if (open?.key === key && input.editable) return renderForm(input, open)
		const page = options.readPage()
		return (
			<span
				mix={css({
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'baseline',
				})}
			>
				{renderStored(page.orgSlug, input.stored, input.inheritLabel)}
				{input.editable ? (
					<button
						type="button"
						aria-label={`Change ${describeMappingTarget(input.target)} for ${input.need.key}`}
						disabled={open?.saving === true}
						mix={[
							css(linkButtonCss),
							on('click', () => {
								openEditor({
									key,
									target: input.target,
									needKey: input.need.key,
									draft: draftFromStored(input.stored),
									saving: false,
									messages: [],
								})
								handle.update()
							}),
						]}
					>
						Change
					</button>
				) : null}
			</span>
		)
	}

	return {
		renderCell,
		reset() {
			openEditor(null)
		},
	}
}

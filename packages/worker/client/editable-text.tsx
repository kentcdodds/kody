import { type Handle } from 'remix/component'

type EditableTextProps = {
	id: string
	ariaLabel: string
	value: string
	emptyText?: string
	buttonCss?: Record<string, unknown>
	inputCss?: Record<string, unknown>
	onSave: (value: string) => Promise<boolean> | boolean
}

const inheritTextStyles = {
	fontSize: 'inherit',
	fontStyle: 'inherit',
	fontWeight: 'inherit',
	fontFamily: 'inherit',
	textAlign: 'inherit',
	lineHeight: 'inherit',
	color: 'inherit',
} as const

export function EditableText(handle: Handle) {
	let isEditing = false
	let draftValue = ''
	let isSaving = false

	function focusInput(inputId: string) {
		void handle.queueTask(async () => {
			const input = document.getElementById(inputId)
			if (!(input instanceof HTMLInputElement)) return
			input.focus()
			input.select()
		})
	}

	function focusButton(buttonId: string) {
		void handle.queueTask(async () => {
			const button = document.getElementById(buttonId)
			if (!(button instanceof HTMLButtonElement)) return
			button.focus()
		})
	}

	return (props: EditableTextProps) => {
		const buttonId = `${props.id}-button`

		function startEditing() {
			if (isSaving) return
			draftValue = props.value
			isEditing = true
			handle.update()
			focusInput(props.id)
		}

		function cancelEditing() {
			if (isSaving) return
			draftValue = props.value
			isEditing = false
			handle.update()
			focusButton(buttonId)
		}

		async function submitEditing(event: SubmitEvent) {
			event.preventDefault()
			if (isSaving) return
			const nextValue = draftValue.trim()
			if (!nextValue) return

			isSaving = true
			handle.update()
			let didSave = false
			try {
				didSave = await props.onSave(nextValue)
			} catch (error) {
				isSaving = false
				handle.update()
				throw error
			}
			isSaving = false
			if (!didSave) {
				handle.update()
				return
			}

			isEditing = false
			handle.update()
			focusButton(buttonId)
		}

		function handleDraftInput(event: Event) {
			if (!(event.currentTarget instanceof HTMLInputElement)) return
			draftValue = event.currentTarget.value
			handle.update()
		}

		function handleDraftKeyDown(event: KeyboardEvent) {
			if (!(event.currentTarget instanceof HTMLInputElement)) return
			if (event.key === 'Escape') {
				event.preventDefault()
				cancelEditing()
				return
			}
			if (event.key === 'Enter') {
				event.preventDefault()
				event.currentTarget.form?.requestSubmit()
			}
		}

		if (isEditing) {
			return (
				<form
					on={{ submit: submitEditing }}
					css={{
						display: 'block',
						width: '100%',
					}}
				>
					<input
						required
						maxLength={120}
						id={props.id}
						type="text"
						name="value"
						aria-label={props.ariaLabel}
						autocomplete="off"
						value={draftValue}
						disabled={isSaving}
						on={{
							input: handleDraftInput,
							keydown: handleDraftKeyDown,
						}}
						css={{
							display: 'block',
							width: 'auto',
							maxWidth: '100%',
							minWidth: '1ch',
							padding: 0,
							border: 'none',
							background: 'none',
							outline: 'none',
							fieldSizing: 'content',
							...inheritTextStyles,
							...props.inputCss,
						}}
					/>
				</form>
			)
		}

		return (
			<button
				id={buttonId}
				type="button"
				on={{ click: startEditing }}
				css={{
					display: 'block',
					width: '100%',
					padding: 0,
					border: 'none',
					background: 'none',
					cursor: 'pointer',
					...inheritTextStyles,
					...props.buttonCss,
				}}
			>
				{props.value.trim() || props.emptyText || 'Edit'}
			</button>
		)
	}
}

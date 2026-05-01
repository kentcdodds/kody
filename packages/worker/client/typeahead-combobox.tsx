import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'

type ComboboxOption = {
	id: string
	label: string
	description?: string | null
}

type TypeaheadComboboxProps = {
	id: string
	label: string
	placeholder?: string
	emptyText?: string
	value: string
	options: Array<ComboboxOption>
	disabled?: boolean
	onChange: (value: string) => void
	inputCss?: Record<string, unknown>
	listCss?: Record<string, unknown>
	optionCss?: Record<string, unknown>
}

export function TypeaheadCombobox(handle: Handle) {
	let isOpen = false
	let query = ''
	let highlightedIndex = 0
	let blurTimeoutId: number | null = null

	function clearBlurTimeout() {
		if (blurTimeoutId == null || typeof window === 'undefined') return
		window.clearTimeout(blurTimeoutId)
		blurTimeoutId = null
	}

	function scheduleClose() {
		if (typeof window === 'undefined') return
		clearBlurTimeout()
		blurTimeoutId = window.setTimeout(() => {
			isOpen = false
			handle.update()
		}, 100)
	}

	return (props: TypeaheadComboboxProps) => {
		const selectedOption =
			props.options.find((option) => option.id === props.value) ?? null
		if (!isOpen && query !== (selectedOption?.label ?? '')) {
			query = selectedOption?.label ?? ''
		}

		const normalizedQuery = query.trim().toLowerCase()
		const filteredOptions = props.options.filter((option) => {
			if (!normalizedQuery) return true
			return [option.label, option.description ?? '']
				.join(' ')
				.toLowerCase()
				.includes(normalizedQuery)
		})
		const hasOptions = filteredOptions.length > 0
		const clampedIndex = hasOptions
			? Math.min(highlightedIndex, filteredOptions.length - 1)
			: 0
		const activeOption = hasOptions ? filteredOptions[clampedIndex] : null
		const inputId = props.id
		const listboxId = `${props.id}-listbox`

		function selectOption(option: ComboboxOption) {
			clearBlurTimeout()
			query = option.label
			highlightedIndex = 0
			isOpen = false
			props.onChange(option.id)
			handle.update()
		}

		function handleFocus() {
			if (props.disabled) return
			clearBlurTimeout()
			isOpen = true
			highlightedIndex = 0
			handle.update()
		}

		function handleBlur() {
			scheduleClose()
		}

		function handleInput(event: Event) {
			if (!(event.currentTarget instanceof HTMLInputElement)) return
			query = event.currentTarget.value
			highlightedIndex = 0
			if (!isOpen) isOpen = true
			handle.update()
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (props.disabled) return
			if (event.key === 'ArrowDown') {
				event.preventDefault()
				if (!isOpen) {
					isOpen = true
					highlightedIndex = 0
				} else if (hasOptions) {
					highlightedIndex = Math.min(
						clampedIndex + 1,
						filteredOptions.length - 1,
					)
				}
				handle.update()
				return
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault()
				if (!isOpen) {
					isOpen = true
					highlightedIndex = hasOptions ? filteredOptions.length - 1 : 0
				} else if (hasOptions) {
					highlightedIndex = Math.max(clampedIndex - 1, 0)
				}
				handle.update()
				return
			}
			if (event.key === 'Enter') {
				if (!isOpen || !activeOption) return
				event.preventDefault()
				selectOption(activeOption)
				return
			}
			if (event.key === 'Escape') {
				if (!isOpen) return
				event.preventDefault()
				isOpen = false
				query = selectedOption?.label ?? ''
				handle.update()
			}
		}

		return (
			<div
				mix={css({
					position: 'relative',
					display: 'grid',
					gap: 'var(--spacing-xs)',
				})}
			>
				<label
					for={inputId}
					mix={css({ display: 'grid', gap: 'var(--spacing-xs)' })}
				>
					<span
						mix={css({
							color: 'var(--color-text)',
							fontWeight: 'var(--font-weight-medium)',
							fontSize: 'var(--font-size-sm)',
						})}
					>
						{props.label}
					</span>
				</label>
				<input
					id={inputId}
					type="text"
					role="combobox"
					autocomplete="off"
					aria-autocomplete="list"
					aria-controls={listboxId}
					aria-expanded={isOpen}
					aria-activedescendant={
						isOpen && activeOption
							? `${props.id}-option-${activeOption.id}`
							: undefined
					}
					placeholder={props.placeholder}
					value={query}
					disabled={props.disabled}
					mix={[
						on(
							'focus',

							handleFocus,
						),
						on('blur', handleBlur),
						on('input', handleInput),
						on('keydown', handleKeyDown),

						css(props.inputCss as never),
					]}
				/>

				{isOpen ? (
					<div
						id={listboxId}
						role="listbox"
						aria-label={props.label}
						mix={css(props.listCss as never)}
					>
						{hasOptions ? (
							filteredOptions.map((option, index) => {
								const isActive = index === clampedIndex
								return (
									<button
										key={option.id}
										id={`${props.id}-option-${option.id}`}
										type="button"
										role="option"
										aria-selected={isActive}
										data-active={isActive ? 'true' : 'false'}
										mix={[
											on(
												'mousedown',

												(event) => {
													event.preventDefault()
													selectOption(option)
												},
											),
											on('mouseenter', () => {
												highlightedIndex = index
												handle.update()
											}),

											css(props.optionCss as never),
										]}
									>
										<span>{option.label}</span>
										{option.description ? (
											<span
												mix={css({
													fontSize: 'var(--font-size-sm)',
													color: 'var(--color-text-muted)',
												})}
											>
												{option.description}
											</span>
										) : null}
									</button>
								)
							})
						) : (
							<div
								mix={css({
									padding: 'var(--spacing-sm)',
									fontSize: 'var(--font-size-sm)',
									color: 'var(--color-text-muted)',
								})}
							>
								{props.emptyText ?? 'No matches'}
							</div>
						)}
					</div>
				) : null}
			</div>
		)
	}
}

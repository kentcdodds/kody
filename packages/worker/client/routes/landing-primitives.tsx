import { type Handle, ref } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { docHref } from '#universal/docs-nav.ts'
import {
	landingHomePrimitives,
	landingPrimitivesIntroLead,
	landingPrimitivesMoreLead,
	landingPrimitivesMoreLink,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'

/**
 * Homepage primitives sentence. Each named primitive is a disclosure button:
 * hover, focus, or click opens one popover; Escape, blur, and leaving the
 * word close it. No-JS keeps the definitions in the document for read-out.
 */

export const landingPrimitivesSectionId = 'primitives'

const whatIsKodyHref = docHref('what-is-kody')

function primitiveSeparator(index: number, count: number) {
	if (index === 0) return null
	if (index === count - 1) return ', and '
	return ', '
}

export function LandingPrimitives(handle: Handle) {
	let openId: string | null = null

	function setOpen(id: string | null) {
		if (openId === id) return
		openId = id
		handle.update()
	}

	return () => (
		<section
			id={landingPrimitivesSectionId}
			aria-label="Kody primitives"
			class="landing-primitives"
		>
			<p class="landing-primitives-lead">
				{landingPrimitivesIntroLead}
				{landingHomePrimitives.map((primitive, index) => (
					<span key={primitive.id}>
						{primitiveSeparator(index, landingHomePrimitives.length)}
						<LandingPrimitiveWord
							primitive={primitive}
							open={openId === primitive.id}
							onOpen={() => setOpen(primitive.id)}
							onClose={() => {
								if (openId === primitive.id) setOpen(null)
							}}
						/>
					</span>
				))}
				.
			</p>
			<p class="landing-primitives-more">
				{landingPrimitivesMoreLead}{' '}
				<a href={whatIsKodyHref} class="landing-inline-link">
					{landingPrimitivesMoreLink}
				</a>
			</p>
		</section>
	)
}

function LandingPrimitiveWord(
	handle: Handle<{
		primitive: LandingHomePrimitive
		open: boolean
		onOpen: () => void
		onClose: () => void
	}>,
) {
	const panelId = `${handle.id}-panel`

	function closeIfLeaving(
		current: EventTarget | null,
		next: EventTarget | null,
	) {
		if (!(current instanceof Element)) return
		if (next instanceof Node && current.contains(next)) return
		handle.props.onClose()
	}

	return () => {
		const { primitive, open, onOpen } = handle.props
		return (
			<span
				class="landing-primitive"
				data-open={open ? '' : undefined}
				mix={[
					on('mouseenter', onOpen),
					on('mouseleave', (event: MouseEvent) => {
						closeIfLeaving(event.currentTarget, event.relatedTarget)
					}),
					on('focusin', onOpen),
					on('focusout', (event: FocusEvent) => {
						closeIfLeaving(event.currentTarget, event.relatedTarget)
					}),
					ref((node: Element, signal: AbortSignal) => {
						const onKeydown = (event: Event) => {
							if (!(event instanceof KeyboardEvent)) return
							if (event.key !== 'Escape') return
							if (!handle.props.open) return
							event.preventDefault()
							handle.props.onClose()
							const trigger = node.querySelector('button')
							if (trigger instanceof HTMLElement) trigger.focus()
						}
						document.addEventListener('keydown', onKeydown, { signal })
					}),
				]}
			>
				<button
					type="button"
					class="landing-primitive-word"
					aria-expanded={open ? 'true' : 'false'}
					aria-controls={panelId}
					aria-describedby={panelId}
				>
					{primitive.word}
				</button>
				<span id={panelId} role="tooltip" class="landing-primitive-popover">
					{primitive.body}
				</span>
			</span>
		)
	}
}

import { type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	landingHomePrimitives,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternImage,
	landingLanternOrbs,
	landingPrimitiveColorVar,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * Five-orb lantern beside the primitives sentence. The art is Kent's
 * standalone lantern still (`kody-primitives-lantern.webp`, orbs painted
 * in). Five transparent buttons sit over the painted orbs so each can take
 * hover, focus, and tap, open the matching primitive popover, and anchor
 * the leader line drawn by the parent section. Orb centres come from
 * `#universal/landing-lantern` so measurement and art stay in one place.
 */

/** Hover opens for mice and pens only. A touch tap fires synthetic enter
 *  and leave events around its click, which would close what the tap just
 *  opened, so touch pointers are ignored here and handled by click. */
export function hoverPointer(event: PointerEvent) {
	return event.pointerType !== 'touch'
}

function primitiveById(id: LandingPrimitiveId): LandingHomePrimitive {
	return landingHomePrimitives.find((primitive) => primitive.id === id)!
}

export type LandingLanternProps = {
	activeId: LandingPrimitiveId | null
	panelId: (id: LandingPrimitiveId) => string
	onOpen: (id: LandingPrimitiveId) => void
	onToggle: (id: LandingPrimitiveId) => void
	onClose: (id: LandingPrimitiveId) => void
	onDismiss: (id: LandingPrimitiveId) => void
	onResume: (id: LandingPrimitiveId) => void
}

export function LandingLantern(handle: Handle<LandingLanternProps>) {
	function leave(id: LandingPrimitiveId) {
		handle.props.onClose(id)
		handle.props.onResume(id)
	}

	return () => {
		const { activeId, panelId, onOpen, onToggle, onDismiss } = handle.props
		return (
			<figure class="landing-lantern">
				<figcaption class="visually-hidden">
					A lantern holding five glowing orbs, one for each Kody primitive.
				</figcaption>
				<img
					src={landingLanternImage.src}
					srcSet={landingLanternImage.srcSet}
					sizes={landingLanternImage.sizes}
					width={landingLanternImage.width}
					height={landingLanternImage.height}
					decoding="async"
					alt=""
					class="landing-lantern-art"
				/>
				<div class="landing-lantern-orbs">
					{landingLanternOrbs.map((orb) => {
						const primitive = primitiveById(orb.id)
						const open = activeId === orb.id
						return (
							<button
								key={orb.id}
								type="button"
								class="landing-lantern-orb"
								data-orb={orb.id}
								data-open={open ? '' : undefined}
								style={{
									'--x': `${orb.x}%`,
									'--y': `${orb.y}%`,
									'--size': `${orb.size}%`,
									'--primitive-color': landingPrimitiveColorVar(orb.id),
								}}
								aria-label={`${primitive.word} primitive`}
								aria-expanded={open ? 'true' : 'false'}
								aria-controls={panelId(orb.id)}
								aria-describedby={panelId(orb.id)}
								mix={[
									on('pointerenter', (event: PointerEvent) => {
										if (hoverPointer(event)) onOpen(orb.id)
									}),
									on('pointerleave', (event: PointerEvent) => {
										if (hoverPointer(event)) leave(orb.id)
									}),
									on('focusin', () => onOpen(orb.id)),
									on('focusout', () => leave(orb.id)),
									on('click', () => onToggle(orb.id)),
									on('keydown', (event: KeyboardEvent) => {
										if (event.key !== 'Escape') return
										event.preventDefault()
										onDismiss(orb.id)
									}),
								]}
							></button>
						)
					})}
				</div>
			</figure>
		)
	}
}

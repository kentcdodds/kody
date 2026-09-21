import { type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { lanternOrbMotion } from '#client/routes/landing-lantern-motion.ts'
import {
	landingHomePrimitives,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternImage,
	landingLanternOrbArt,
	landingLanternOrbs,
	landingPrimitiveColorVar,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * Six-orb lantern beside the primitives sentence. The shell is static.
 * Each orb image sits inside its hotspot button, centered on the painted
 * disc, so the highlight ring, the disc, and the leader rim share one
 * centre while the button moves.
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
	/** Hero reuse: same physics and layers, no disclosures. */
	decorative?: boolean
}

export function LandingLantern(handle: Handle<LandingLanternProps>) {
	const motion = lanternOrbMotion()

	function leave(id: LandingPrimitiveId) {
		handle.props.onClose(id)
		handle.props.onResume(id)
	}

	return () => {
		const { activeId, panelId, onOpen, onToggle, onDismiss, decorative } =
			handle.props
		return (
			<figure
				class="landing-lantern"
				data-decorative={decorative ? '' : undefined}
				mix={motion}
			>
				<figcaption class="visually-hidden">
					A lantern holding six glowing orbs, one for each Kody primitive.
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
						const art = (
							<img
								src={landingLanternOrbArt[orb.id]}
								alt=""
								decoding="async"
								draggable="false"
								class="landing-lantern-orb-art"
								data-orb-art={orb.id}
								data-open={open ? '' : undefined}
							/>
						)
						const pose = {
							'--x': `${orb.x}%`,
							'--y': `${orb.y}%`,
							'--size': `${orb.size}%`,
							'--art': `${orb.art}%`,
							'--primitive-color': landingPrimitiveColorVar(orb.id),
						}
						if (decorative) {
							return (
								<span
									key={orb.id}
									class="landing-lantern-orb"
									data-orb={orb.id}
									style={pose}
									aria-hidden="true"
								>
									{art}
								</span>
							)
						}
						return (
							<button
								key={orb.id}
								type="button"
								class="landing-lantern-orb"
								data-orb={orb.id}
								data-open={open ? '' : undefined}
								style={pose}
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
							>
								{art}
							</button>
						)
					})}
				</div>
			</figure>
		)
	}
}

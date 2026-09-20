import { type Handle, type RemixNode } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { iconicGlyphViewBox, renderIcon } from '#universal/icon.tsx'
import {
	landingHomePrimitives,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternOrbs,
	landingPrimitiveColorVar,
	type LandingLanternGlyph,
	type LandingLanternOrb,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * Five-orb lantern beside the primitives sentence. The glass, cap, handle,
 * and base are one decorative inline SVG; the five orbs are real buttons
 * layered over it so they can take hover and focus, open the matching
 * primitive popover, and anchor the leader lines drawn by the parent
 * section. Positions come from `#universal/landing-lantern` so the leader
 * measurement and any future still (OG card) share one layout.
 */

/** Stage size in viewBox units; the orbs use the same aspect via CSS. */
export const landingLanternViewBox = { width: 200, height: 260 } as const

const glassCenter = { x: 100, y: 164, r: 78 } as const

function orbPoint(orb: LandingLanternOrb) {
	return {
		x: (orb.x / 100) * landingLanternViewBox.width,
		y: (orb.y / 100) * landingLanternViewBox.height,
	}
}

/** Web of faint golden threads between the orbs, like the asset's network. */
const orbWeb: ReadonlyArray<[LandingPrimitiveId, LandingPrimitiveId]> = [
	['memory', 'secrets'],
	['memory', 'packages'],
	['secrets', 'jobs'],
	['packages', 'integrations'],
	['jobs', 'integrations'],
	['secrets', 'integrations'],
	['packages', 'jobs'],
	['memory', 'jobs'],
]

const sparkles = [
	{ x: 60, y: 120, r: 1.6 },
	{ x: 138, y: 112, r: 1.2 },
	{ x: 44, y: 190, r: 1.3 },
	{ x: 160, y: 186, r: 1.7 },
	{ x: 100, y: 228, r: 1.1 },
	{ x: 118, y: 136, r: 1 },
	{ x: 82, y: 176, r: 0.9 },
	{ x: 150, y: 214, r: 1 },
	{ x: 96, y: 96, r: 1.1 },
	{ x: 36, y: 150, r: 0.8 },
	{ x: 168, y: 150, r: 0.9 },
	{ x: 126, y: 100, r: 0.7 },
	{ x: 72, y: 100, r: 0.8 },
	{ x: 100, y: 190, r: 1.3 },
	{ x: 58, y: 232, r: 0.8 },
	{ x: 142, y: 236, r: 0.9 },
	{ x: 112, y: 214, r: 0.7 },
	{ x: 86, y: 140, r: 0.7 },
] as const

function orbById(id: LandingPrimitiveId) {
	return landingLanternOrbs.find((orb) => orb.id === id)!
}

function primitiveById(id: LandingPrimitiveId): LandingHomePrimitive {
	return landingHomePrimitives.find((primitive) => primitive.id === id)!
}

function renderLocalGlyph(children: RemixNode) {
	return (
		<svg
			viewBox={iconicGlyphViewBox}
			width="1em"
			height="1em"
			fill="none"
			aria-hidden="true"
			focusable={false}
		>
			{children}
		</svg>
	)
}

/** Brain and gear are not in the Iconic set; drawn to the same 24 box. */
export function renderLanternGlyph(glyph: LandingLanternGlyph) {
	switch (glyph) {
		case 'lock':
			return renderIcon('lock')
		case 'cube':
			return renderIcon('box')
		case 'plug':
			return renderIcon('plug')
		case 'brain':
			return renderLocalGlyph(
				<>
					<path
						stroke="currentColor"
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M12 6.5C11 5 8.5 5 7.6 6.8 5.8 7 5 9 5.9 10.5 4.6 11.6 4.9 13.9 6.5 14.5 6.3 16.4 8 17.8 9.8 17 10.4 18.4 11.2 18.6 12 18.5"
					/>
					<path
						stroke="currentColor"
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M12 6.5C13 5 15.5 5 16.4 6.8 18.2 7 19 9 18.1 10.5 19.4 11.6 19.1 13.9 17.5 14.5 17.7 16.4 16 17.8 14.2 17 13.6 18.4 12.8 18.6 12 18.5"
					/>
					<path
						stroke="currentColor"
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="1.5"
						d="M12 6.5v12M9 9.5c1 .5 1.5 1.5 1.5 2.5M15 9.5c-1 .5-1.5 1.5-1.5 2.5"
					/>
				</>,
			)
		case 'gear':
			return renderLocalGlyph(
				<>
					<circle
						cx="12"
						cy="12"
						r="6"
						stroke="currentColor"
						stroke-width="1.5"
					/>
					<circle
						cx="12"
						cy="12"
						r="2.25"
						stroke="currentColor"
						stroke-width="1.5"
					/>
					<path
						stroke="currentColor"
						stroke-linecap="round"
						stroke-width="2.4"
						d="M12 6V4.25M12 18v1.75M6 12H4.25M18 12h1.75M16.24 7.76l1.24-1.24M7.76 7.76 6.52 6.52M7.76 16.24l-1.24 1.24M16.24 16.24l1.24 1.24"
					/>
				</>,
			)
		default: {
			const exhaustive: never = glyph
			throw new Error(`Unknown lantern glyph: ${String(exhaustive)}`)
		}
	}
}

function renderLanternArt(uid: string) {
	const glassId = `${uid}-glass`
	const haloId = `${uid}-halo`
	const metalId = `${uid}-metal`
	const rimId = `${uid}-rim`
	const { x, y, r } = glassCenter
	return (
		<svg
			class="landing-lantern-art"
			viewBox={`0 0 ${landingLanternViewBox.width} ${landingLanternViewBox.height}`}
			aria-hidden="true"
			focusable={false}
		>
			<defs>
				<radialGradient id={glassId} cx="50%" cy="40%" r="62%">
					<stop offset="0" class="landing-lantern-glass-stop-a" />
					<stop offset="0.55" class="landing-lantern-glass-stop-b" />
					<stop offset="1" class="landing-lantern-glass-stop-c" />
				</radialGradient>
				<radialGradient id={haloId} cx="50%" cy="50%" r="50%">
					<stop offset="0" class="landing-lantern-halo-stop-a" />
					<stop offset="1" class="landing-lantern-halo-stop-b" />
				</radialGradient>
				<linearGradient id={metalId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" class="landing-lantern-metal-stop-a" />
					<stop offset="1" class="landing-lantern-metal-stop-b" />
				</linearGradient>
				<linearGradient id={rimId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" class="landing-lantern-rim-stop-a" />
					<stop offset="1" class="landing-lantern-rim-stop-b" />
				</linearGradient>
			</defs>
			<circle
				class="landing-lantern-halo"
				cx={x}
				cy={y}
				r={r + 26}
				fill={`url(#${haloId})`}
			/>
			<path
				class="landing-lantern-handle landing-lantern-metal"
				d="M64 58A36 36 0 1 1 136 58"
				fill="none"
				stroke={`url(#${metalId})`}
				stroke-width="13"
				stroke-linecap="round"
			/>
			<path
				class="landing-lantern-handle-shine"
				d="M66 56A34 34 0 1 1 134 56"
				fill="none"
				stroke-width="2.5"
				stroke-linecap="round"
			/>
			<ellipse class="landing-lantern-knob" cx="100" cy="54" rx="24" ry="5" />
			<rect
				class="landing-lantern-metal"
				x="58"
				y="54"
				width="84"
				height="28"
				rx="8"
				fill={`url(#${metalId})`}
			/>
			<circle
				class="landing-lantern-glass"
				cx={x}
				cy={y}
				r={r}
				fill={`url(#${glassId})`}
			/>
			<g class="landing-lantern-web">
				{orbWeb.map(([fromId, toId]) => {
					const from = orbPoint(orbById(fromId))
					const to = orbPoint(orbById(toId))
					return (
						<line
							key={`${fromId}-${toId}`}
							x1={from.x}
							y1={from.y}
							x2={to.x}
							y2={to.y}
						/>
					)
				})}
				{orbWeb.map(([fromId, toId]) => {
					const from = orbPoint(orbById(fromId))
					const to = orbPoint(orbById(toId))
					return (
						<circle
							key={`node-${fromId}-${toId}`}
							cx={(from.x + to.x) / 2}
							cy={(from.y + to.y) / 2}
							r="1.4"
						/>
					)
				})}
			</g>
			<g class="landing-lantern-sparkles">
				{sparkles.map((sparkle) => (
					<circle
						key={`${sparkle.x}-${sparkle.y}`}
						cx={sparkle.x}
						cy={sparkle.y}
						r={sparkle.r}
					/>
				))}
			</g>
			<ellipse
				class="landing-lantern-glass-shine"
				cx="70"
				cy="118"
				rx="22"
				ry="11"
				transform="rotate(-32 70 118)"
			/>
			<circle
				class="landing-lantern-glass-vignette"
				cx={x}
				cy={y}
				r={r}
				fill="none"
				stroke-width="10"
			/>
			<circle
				class="landing-lantern-glass-rim"
				cx={x}
				cy={y}
				r={r - 1}
				fill="none"
				stroke={`url(#${rimId})`}
				stroke-width="2.5"
			/>
			<ellipse
				class="landing-lantern-glass-foot"
				cx={x}
				cy="236"
				rx="52"
				ry="5"
			/>
			<rect
				class="landing-lantern-lip"
				x="46"
				y="78"
				width="108"
				height="16"
				rx="6"
			/>
			<rect
				class="landing-lantern-metal"
				x="46"
				y="230"
				width="108"
				height="20"
				rx="8"
				fill={`url(#${metalId})`}
			/>
			<rect
				class="landing-lantern-lip"
				x="36"
				y="243"
				width="128"
				height="17"
				rx="7"
			/>
		</svg>
	)
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
				{renderLanternArt(handle.id)}
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
									'--primitive-color': landingPrimitiveColorVar(orb.id),
								}}
								aria-label={`${primitive.word} primitive`}
								aria-expanded={open ? 'true' : 'false'}
								aria-controls={panelId(orb.id)}
								aria-describedby={panelId(orb.id)}
								mix={[
									on('mouseenter', () => onOpen(orb.id)),
									on('mouseleave', () => leave(orb.id)),
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
								<span class="landing-lantern-orb-glyph" aria-hidden="true">
									{renderLanternGlyph(orb.glyph)}
								</span>
							</button>
						)
					})}
				</div>
			</figure>
		)
	}
}

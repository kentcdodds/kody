import { type Handle, on, type RemixNode } from 'remix/component'
import { primitiveWidgetMotion } from '#client/primitive-widget-motion.ts'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/**
 * Building blocks for primitive widget scenes: the homepage and `/features`
 * cards (`primitive-widgets.tsx`) and the feature page scenes
 * (`routes/features/*-scenes.tsx`).
 *
 * A scene is plain markup on a stage 360 units wide and `height` units tall
 * (200 by default). Nodes sit at percentages, wires live in one SVG with the
 * same viewBox, and the type scales with the stage width (`cqw`, 30em
 * across), so a scene is the same picture at any size. Loops are CSS gated by
 * `data-motion` from `primitiveWidgetMotion`; without it the scene is a
 * finished still, which is also the reduced-motion and no-JS view.
 */

export type PrimitiveWidgetSize = 'full' | 'mini'

const stageWidth = 360

export function PrimitiveWidgetFrame(
	handle: Handle<{
		id: LandingPrimitiveId
		size: PrimitiveWidgetSize
		/** Stage height in stage units; the width is always 360. */
		height?: number
		/** Extra classes, e.g. a scene name for scene-scoped styles. */
		class?: string
		children?: RemixNode
	}>,
) {
	const motion = primitiveWidgetMotion()
	return () => {
		const { id, size, height, class: extra, children } = handle.props
		return (
			<div
				class={extra ? `pw pw-${id} ${extra}` : `pw pw-${id}`}
				data-size={size}
				aria-hidden={size === 'mini' ? 'true' : undefined}
				style={{
					'--pw-accent': `var(--primitive-${id})`,
					...(height ? { '--pw-ratio': `${stageWidth} / ${height}` } : {}),
				}}
				mix={motion}
			>
				<div class="pw-stage">{children}</div>
			</div>
		)
	}
}

export function at(x: number, y: number, extra?: Record<string, string>) {
	return { left: `${x}%`, top: `${y}%`, ...extra }
}

export function icon(name: string) {
	return (
		<span
			class="pw-icon"
			aria-hidden="true"
			style={{ '--pw-icon': `url("/images/icons/${name}.svg")` }}
		></span>
	)
}

export function wires(children: RemixNode, height = 200) {
	return (
		<svg
			class="pw-wires"
			viewBox={`0 0 ${stageWidth} ${height}`}
			aria-hidden="true"
			focusable={false}
		>
			{children}
		</svg>
	)
}

/** One wire: the resting line, the looping pulse, and a one-shot pulse
 *  keyed by `shot` so a click replays it. */
export function wire(options: {
	d: string
	i?: number
	on?: boolean
	shot?: number
	key?: string
}) {
	const { d, i = 0, on: lit = false, shot = 0, key } = options
	return (
		<g
			key={key}
			class="pw-wire"
			data-on={lit ? '' : undefined}
			style={{ '--i': String(i) }}
		>
			<path class="pw-line" d={d} />
			<path class="pw-pulse" d={d} pathLength="100" />
			{shot > 0 ? (
				<path key={`shot-${shot}`} class="pw-shot" d={d} pathLength="100" />
			) : null}
		</g>
	)
}

/** A pickable node: a pressed-state button with a handler, else a still. */
export function choice(options: {
	class: string
	selected: boolean
	onPick?: () => void
	style?: Record<string, string>
	label?: string
	children: RemixNode
}) {
	const { class: className, selected, onPick, style, label, children } = options
	if (!onPick) {
		return (
			<span class={className} data-on={selected ? '' : undefined} style={style}>
				{children}
			</span>
		)
	}
	return (
		<button
			type="button"
			class={className}
			aria-pressed={selected ? 'true' : 'false'}
			aria-label={label}
			style={style}
			mix={on('click', onPick)}
		>
			{children}
		</button>
	)
}

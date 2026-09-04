import { type Handle, ref } from 'remix/ui'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	listCodingWalkthroughHosts,
	walkthroughHostMarkUrl,
	type WalkthroughHost,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'

/** Dummy value so the native password control paints dots. Never a real key. */
export const landingByokDemoSecret = 'sk-kody-byok-key'

/** Class added after hydrate to start the loop. First paint stays still. */
export const landingByokPlayingClass = 'is-playing'
export const landingByokClickingClass = 'is-clicking'
export const landingByokShakingClass = 'is-shaking'

export const landingByokLoopMs = 4800

export type ByokPoint = { x: number; y: number }

export type ByokCubic = {
	p0: ByokPoint
	p1: ByokPoint
	p2: ByokPoint
	p3: ByokPoint
}

export type ByokLoopPhase =
	| { kind: 'park' }
	| { kind: 'out'; t: number }
	| { kind: 'click' }
	| { kind: 'in'; t: number }

export function landingByokEaseInOut(t: number) {
	const clamped = Math.min(1, Math.max(0, t))
	return clamped < 0.5
		? 4 * clamped * clamped * clamped
		: 1 - (-2 * clamped + 2) ** 3 / 2
}

export function landingByokCubicPoint(curve: ByokCubic, t: number): ByokPoint {
	const u = 1 - t
	const tt = t * t
	const uu = u * u
	return {
		x:
			uu * u * curve.p0.x +
			3 * uu * t * curve.p1.x +
			3 * u * tt * curve.p2.x +
			tt * t * curve.p3.x,
		y:
			uu * u * curve.p0.y +
			3 * uu * t * curve.p1.y +
			3 * u * tt * curve.p2.y +
			tt * t * curve.p3.y,
	}
}

/**
 * Cubic through `from` → `to`: first handle bulges off the beeline, second
 * handle sits past the target so the path overshoots then settles. `bulge`
 * sign picks which side of the line (outbound vs inbound use opposites).
 */
export function landingByokBeelineCubic(
	from: ByokPoint,
	to: ByokPoint,
	bulgeSign: 1 | -1,
): ByokCubic {
	const dx = to.x - from.x
	const dy = to.y - from.y
	const length = Math.hypot(dx, dy)
	if (length === 0) {
		return { p0: from, p1: from, p2: to, p3: to }
	}
	const ux = dx / length
	const uy = dy / length
	const nx = -uy * bulgeSign
	const ny = ux * bulgeSign
	const bulge = Math.min(22, length * 0.16)
	const overshoot = Math.min(11, length * 0.07)
	return {
		p0: from,
		p1: {
			x: from.x + dx * 0.36 + nx * bulge,
			y: from.y + dy * 0.36 + ny * bulge,
		},
		p2: {
			x: to.x + ux * overshoot + nx * bulge * 0.22,
			y: to.y + uy * overshoot + ny * bulge * 0.22,
		},
		p3: to,
	}
}

export function landingByokLoopPhase(progress: number): ByokLoopPhase {
	const p = ((progress % 1) + 1) % 1
	if (p < 0.1) return { kind: 'park' }
	if (p < 0.32) return { kind: 'out', t: (p - 0.1) / 0.22 }
	if (p < 0.58) return { kind: 'click' }
	if (p < 0.8) return { kind: 'in', t: (p - 0.58) / 0.22 }
	return { kind: 'park' }
}

export function landingByokLoopPoint(
	progress: number,
	from: ByokPoint,
	to: ByokPoint,
): ByokPoint {
	const phase = landingByokLoopPhase(progress)
	switch (phase.kind) {
		case 'park':
			return from
		case 'out':
			return landingByokCubicPoint(
				landingByokBeelineCubic(from, to, 1),
				landingByokEaseInOut(phase.t),
			)
		case 'click':
			return to
		case 'in':
			return landingByokCubicPoint(
				landingByokBeelineCubic(to, from, 1),
				landingByokEaseInOut(phase.t),
			)
		default: {
			const exhaustive: never = phase
			return exhaustive
		}
	}
}

export function landingByokLoopFlags(progress: number) {
	const p = ((progress % 1) + 1) % 1
	return {
		clicking: p >= 0.34 && p < 0.44,
		shaking: p >= 0.36 && p < 0.56,
	}
}

/**
 * Cursor identity: the walkthrough chooser's coding host — the same
 * `hosts.coding` that drives the loop teaser. Catalog-first coding
 * host when no pick is in yet — never a client-only shuffle.
 */
export function pickByokDemoHost(
	hosts?: WalkthroughHostPick | null,
): WalkthroughHost {
	const host = hosts?.coding ?? listCodingWalkthroughHosts()[0]
	if (!host) {
		throw new Error('BYOK demo needs a walkthrough host')
	}
	return host
}

/** Motion only when we have a reduced-motion answer and it is not reduce. */
export function landingByokDemoShouldAnimate(
	query: { matches: boolean } | null,
) {
	return query != null && !query.matches
}

function reducedMotionQuery() {
	if (typeof matchMedia !== 'function') return null
	return matchMedia('(prefers-reduced-motion: reduce)')
}

function readOffsetPx(node: HTMLElement, name: string) {
	const raw = node.style.getPropertyValue(name).trim()
	if (!raw) return 0
	const value = Number.parseFloat(raw)
	return Number.isFinite(value) ? value : 0
}

function measureByokTravel(cursor: HTMLElement, eye: HTMLElement) {
	const hotspot = cursor.querySelector('.landing-byok-hotspot') ?? cursor
	const hotBox = hotspot.getBoundingClientRect()
	const eyeBox = eye.getBoundingClientRect()
	const parkedX =
		hotBox.left + hotBox.width / 2 - readOffsetPx(cursor, '--byok-x')
	const parkedY =
		hotBox.top + hotBox.height / 2 - readOffsetPx(cursor, '--byok-y')
	return {
		from: { x: 0, y: 0 },
		to: {
			x: eyeBox.left + eyeBox.width / 2 - parkedX,
			y: eyeBox.top + eyeBox.height / 2 - parkedY,
		},
	}
}

function applyByokCursor(cursor: HTMLElement, point: ByokPoint, scale: number) {
	cursor.style.setProperty('--byok-x', `${point.x}px`)
	cursor.style.setProperty('--byok-y', `${point.y}px`)
	cursor.style.setProperty('--byok-scale', String(scale))
}

function resetByokCursor(node: HTMLElement, cursor: HTMLElement | null) {
	node.classList.remove(
		landingByokPlayingClass,
		landingByokClickingClass,
		landingByokShakingClass,
	)
	if (!cursor) return
	cursor.style.removeProperty('--byok-x')
	cursor.style.removeProperty('--byok-y')
	cursor.style.removeProperty('--byok-scale')
}

/**
 * First render is the parked still. After insert (hydrate), one rAF starts
 * the beeline loop. Reduced-motion never gets the class or offsets.
 */
export function armLandingByokDemo(node: HTMLElement, signal: AbortSignal) {
	const media = reducedMotionQuery()
	const cursorNode = node.querySelector('.landing-byok-cursor')
	const eyeNode = node.querySelector('.landing-byok-eye')
	if (
		!(cursorNode instanceof HTMLElement) ||
		!(eyeNode instanceof HTMLElement) ||
		!landingByokDemoShouldAnimate(media)
	) {
		return
	}
	const cursor = cursorNode
	const eye = eyeNode

	let travel = measureByokTravel(cursor, eye)
	let startMs = 0
	let frame = 0

	function playFrame(now: number) {
		if (signal.aborted || !landingByokDemoShouldAnimate(media)) return
		if (startMs === 0) startMs = now
		const progress = ((now - startMs) % landingByokLoopMs) / landingByokLoopMs
		const flags = landingByokLoopFlags(progress)
		const point = landingByokLoopPoint(progress, travel.from, travel.to)
		applyByokCursor(cursor, point, flags.clicking ? 0.9 : 1)
		node.classList.toggle(landingByokClickingClass, flags.clicking)
		node.classList.toggle(landingByokShakingClass, flags.shaking)
		frame = requestAnimationFrame(playFrame)
	}

	function startLoop() {
		if (signal.aborted || !landingByokDemoShouldAnimate(media)) return
		travel = measureByokTravel(cursor, eye)
		startMs = 0
		node.classList.add(landingByokPlayingClass)
		cancelAnimationFrame(frame)
		frame = requestAnimationFrame(playFrame)
	}

	function stopLoop() {
		cancelAnimationFrame(frame)
		frame = 0
		resetByokCursor(node, cursor)
	}

	const kickoff = requestAnimationFrame(() => {
		if (signal.aborted || !landingByokDemoShouldAnimate(media)) return
		startLoop()
	})

	const onResize = () => {
		travel = measureByokTravel(cursor, eye)
	}
	const onChange = () => {
		if (signal.aborted) return
		if (landingByokDemoShouldAnimate(media)) startLoop()
		else stopLoop()
	}
	media?.addEventListener('change', onChange)
	window.addEventListener('resize', onResize, { passive: true, signal })
	signal.addEventListener(
		'abort',
		() => {
			cancelAnimationFrame(kickoff)
			stopLoop()
			media?.removeEventListener('change', onChange)
		},
		{ once: true },
	)
}

/**
 * Classic OS arrow (Windows IDC_ARROW proportions). Tip is at 0,0 so
 * travel offsets keep the hotspot on the eye. Left flank is vertical;
 * stem sides are parallel; right flank is one straight edge. A slight
 * CSS rotate tilts the icon; the path itself is not skewed.
 */
const landingByokCursorPath = 'M0 0V16L3.5 12.5 6 18.5 8.5 17.5 6 11.5H11Z'

function renderByokCursorPointer() {
	return (
		<svg
			class="landing-byok-cursor-shape"
			viewBox="-2.5 -2.5 16 24"
			width="20"
			height="30"
			aria-hidden="true"
		>
			<path
				d={landingByokCursorPath}
				fill="#fff"
				stroke="#111"
				stroke-width="1.75"
				stroke-linejoin="miter"
				stroke-linecap="butt"
				stroke-miterlimit="4"
				paint-order="stroke fill"
				vector-effect="non-scaling-stroke"
			/>
		</svg>
	)
}

/**
 * Decorative BYOK “agent never sees the key” loop. SSR and the first
 * client render paint the same parked still (password + eye + agent).
 * Motion is enhance-only (`html.js` + `is-playing` after hydrate) and
 * off under `prefers-reduced-motion: reduce`.
 */
export function LandingByokDemo(
	handle: Handle<{ hosts?: WalkthroughHostPick }>,
) {
	return () => {
		const host = pickByokDemoHost(handle.props.hosts)
		return (
			<div
				class="landing-byok-demo"
				role="img"
				aria-label={`${host.label} tries to reveal a secret key and is denied`}
				inert
				mix={ref((node: Element, signal: AbortSignal) => {
					armLandingByokDemo(node as HTMLElement, signal)
				})}
			>
				<div class="landing-byok-stage">
					<div class="landing-byok-field">
						<input
							type="password"
							class="landing-byok-input"
							value={landingByokDemoSecret}
							tabIndex={-1}
							readOnly
							{...passwordManagerIgnoreProps}
						/>
						<span class="landing-byok-eye">
							<svg
								viewBox="0 0 24 24"
								width="22"
								height="22"
								aria-hidden="true"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M2.6 12s3.4-6.4 9.4-6.4S21.4 12 21.4 12s-3.4 6.4-9.4 6.4S2.6 12 2.6 12Z" />
								<circle cx="12" cy="12" r="2.7" />
							</svg>
						</span>
					</div>
					<span class="landing-byok-cursor">
						<span class="landing-byok-hotspot"></span>
						{renderByokCursorPointer()}
						<span class="landing-byok-cursor-mark" aria-hidden="true">
							<img
								class="landing-byok-cursor-mark-icon"
								src={walkthroughHostMarkUrl(host)}
								alt=""
								width="18"
								height="18"
							/>
						</span>
					</span>
				</div>
			</div>
		)
	}
}

/**
 * Pure collision and motion helpers for the status page Breakout game.
 * No DOM access so node tests can import this module directly.
 */

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{ nx: number, ny: number, depth: number }} Contact
 * @typedef {{ vx: number, vy: number }} Velocity
 * @typedef {{ x: number, y: number, w: number, h: number }} Piece
 */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
export function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value))
}

/**
 * Circle vs axis-aligned rect. The normal points from the rect toward the
 * circle center; `depth` is how far to push the circle out along it.
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @param {Rect} rect
 * @returns {Contact | null}
 */
export function collideCircleRect(cx, cy, radius, rect) {
	const px = clamp(cx, rect.left, rect.right)
	const py = clamp(cy, rect.top, rect.bottom)
	const dx = cx - px
	const dy = cy - py
	const distanceSquared = dx * dx + dy * dy
	if (distanceSquared > radius * radius) return null
	if (distanceSquared > 0) {
		const distance = Math.sqrt(distanceSquared)
		return { nx: dx / distance, ny: dy / distance, depth: radius - distance }
	}
	const toLeft = cx - rect.left
	const toRight = rect.right - cx
	const toTop = cy - rect.top
	const toBottom = rect.bottom - cy
	const nearest = Math.min(toLeft, toRight, toTop, toBottom)
	if (nearest === toTop) return { nx: 0, ny: -1, depth: toTop + radius }
	if (nearest === toBottom) return { nx: 0, ny: 1, depth: toBottom + radius }
	if (nearest === toLeft) return { nx: -1, ny: 0, depth: toLeft + radius }
	return { nx: 1, ny: 0, depth: toRight + radius }
}

/**
 * Mirror velocity across a contact normal. Velocity already moving away from
 * the surface is returned unchanged so overlapping contacts cannot flip the
 * ball back into the brick it just left.
 * @param {number} vx
 * @param {number} vy
 * @param {number} nx
 * @param {number} ny
 * @returns {Velocity}
 */
export function reflect(vx, vy, nx, ny) {
	const dot = vx * nx + vy * ny
	if (dot >= 0) return { vx, vy }
	return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny }
}

/**
 * Rescale to `speed` while keeping at least `minVerticalRatio` of it vertical,
 * so the ball never settles into an endless wall-to-wall horizontal loop.
 * @param {number} vx
 * @param {number} vy
 * @param {number} speed
 * @param {number} [minVerticalRatio]
 * @returns {Velocity}
 */
export function normalizeVelocity(vx, vy, speed, minVerticalRatio = 0.3) {
	const length = Math.hypot(vx, vy) || 1
	let nx = vx / length
	let ny = vy / length
	if (Math.abs(ny) < minVerticalRatio) {
		ny = (ny < 0 ? -1 : 1) * minVerticalRatio
		nx = (nx < 0 ? -1 : 1) * Math.sqrt(1 - ny * ny)
	}
	return { vx: nx * speed, vy: ny * speed }
}

/**
 * Classic Breakout steering: where the ball lands on the paddle (-1 left edge,
 * 1 right edge) picks the launch angle, and paddle motion adds some english.
 * Always returns an upward velocity at `speed`.
 * @param {{ offset: number, paddleVelocity: number, speed: number, maxAngle?: number }} input
 * @returns {Velocity}
 */
export function paddleBounce({
	offset,
	paddleVelocity,
	speed,
	maxAngle = Math.PI / 3,
}) {
	const angle = clamp(offset, -1, 1) * maxAngle
	const vx = Math.sin(angle) * speed + paddleVelocity * 0.2
	const vy = -Math.cos(angle) * speed
	const next = normalizeVelocity(vx, vy, speed)
	return { vx: next.vx, vy: -Math.abs(next.vy) }
}

/**
 * Sub-steps needed so one step never moves farther than half the radius;
 * keeps a fast ball from tunneling through 2px day bars.
 * @param {number} distance
 * @param {number} radius
 */
export function subStepCount(distance, radius) {
	return Math.max(1, Math.ceil(distance / Math.max(radius * 0.5, 0.5)))
}

/**
 * Split a `width` x `height` box into a grid of pieces about `pieceSize`
 * across, capped at `maxPieces`. Pieces tile the box exactly.
 * @param {number} width
 * @param {number} height
 * @param {number} pieceSize
 * @param {number} maxPieces
 * @returns {Array<Piece>}
 */
export function shardGrid(width, height, pieceSize, maxPieces) {
	if (width <= 0 || height <= 0) return []
	let cols = Math.max(1, Math.round(width / pieceSize))
	let rows = Math.max(1, Math.round(height / pieceSize))
	if (cols * rows > maxPieces) {
		const shrink = Math.sqrt(maxPieces / (cols * rows))
		cols = Math.max(1, Math.floor(cols * shrink))
		rows = Math.max(1, Math.floor(rows * shrink))
	}
	// The proportional shrink overshoots when one side clamps at 1.
	while (cols * rows > maxPieces && cols * rows > 1) {
		if (rows >= cols) rows--
		else cols--
	}
	const pieceWidth = width / cols
	const pieceHeight = height / rows
	/** @type {Array<Piece>} */
	const pieces = []
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			pieces.push({
				x: col * pieceWidth,
				y: row * pieceHeight,
				w: pieceWidth,
				h: pieceHeight,
			})
		}
	}
	return pieces
}

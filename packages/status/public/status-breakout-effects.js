/* oxlint-disable no-undef -- browser module served from public/; the lint
   config's browser env does not apply here. */
import { clamp, shardGrid } from './status-breakout-physics.js'

const gravity = 1400
const maxShards = 2600
const ringLife = 0.45

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{ x: number, y: number, vx: number, vy: number }} Impact
 * @typedef {Rect & { vx: number }} PaddleBody
 * @typedef {{ color: string } | { texture: HTMLCanvasElement }} ShardFill
 * @typedef {{ x: number, y: number, w: number, h: number, vx: number, vy: number, angle: number, spin: number, life: number, maxLife: number, fill: ShardFill, sx: number, sy: number }} Shard
 */

/**
 * Debris, blast rings, score popups, and screen shake. Shards fall under
 * gravity, spin, bounce off the paddle, and shrink and fade as they dissolve.
 * @param {{ reducedMotion: boolean, fontFamily: string }} options
 */
export function createEffects({ reducedMotion, fontFamily }) {
	/** @type {Array<Shard>} */
	let shards = []
	/** @type {Array<{ x: number, y: number, text: string, color: string, life: number }>} */
	let popups = []
	/** @type {Array<{ x: number, y: number, radius: number, growth: number, color: string, life: number }>} */
	let rings = []
	let shake = 0

	return {
		/**
		 * Break `rect` into pieces that fly away from `impact`.
		 * @param {Rect} rect
		 * @param {Impact} impact
		 * @param {ShardFill} fill
		 * @param {{ pieceSize: number, maxPieces: number, dpr: number }} grain
		 */
		shatter(rect, impact, fill, { pieceSize, maxPieces, dpr }) {
			const pieces = shardGrid(
				rect.right - rect.left,
				rect.bottom - rect.top,
				reducedMotion ? pieceSize * 2 : pieceSize,
				reducedMotion ? Math.ceil(maxPieces / 4) : maxPieces,
			)
			for (const piece of pieces) {
				const x = rect.left + piece.x + piece.w / 2
				const y = rect.top + piece.y + piece.h / 2
				const dx = x - impact.x
				const dy = y - impact.y
				const distance = Math.hypot(dx, dy) || 1
				const burst = 60 + Math.random() * 220
				const maxLife = 0.9 + Math.random() * 1.1
				shards.push({
					x,
					y,
					w: piece.w,
					h: piece.h,
					vx:
						(dx / distance) * burst +
						impact.vx * 0.18 +
						(Math.random() - 0.5) * 80,
					vy: (dy / distance) * burst + impact.vy * 0.18 - Math.random() * 140,
					angle: 0,
					spin: (Math.random() - 0.5) * 16,
					life: maxLife,
					maxLife,
					fill,
					sx: piece.x * dpr,
					sy: piece.y * dpr,
				})
			}
			if (shards.length > maxShards) {
				shards = shards.slice(shards.length - maxShards)
			}
		},

		/** @param {number} x @param {number} y @param {number} radius @param {string} color */
		ring(x, y, radius, color) {
			rings.push({
				x,
				y,
				radius: 0,
				growth: radius * 2.6,
				color,
				life: ringLife,
			})
		},

		/** @param {number} x @param {number} y @param {string} text @param {string} color */
		popup(x, y, text, color) {
			popups.push({ x, y, text, color, life: 1 })
		},

		/** @param {number} amount */
		addShake(amount) {
			if (!reducedMotion) shake = Math.min(14, shake + amount)
		},

		/** Random offset for this frame; apply it to the page and the canvas. */
		shakeOffset() {
			if (shake <= 0) return { x: 0, y: 0 }
			return {
				x: (Math.random() - 0.5) * shake * 2,
				y: (Math.random() - 0.5) * shake * 2,
			}
		},

		/** @param {number} dt @param {PaddleBody} paddle @param {number} floor */
		update(dt, paddle, floor) {
			const drag = 1 - Math.min(1, dt * 0.6)
			for (const shard of shards) {
				shard.vy += gravity * dt
				shard.vx *= drag
				shard.x += shard.vx * dt
				shard.y += shard.vy * dt
				shard.angle += shard.spin * dt
				shard.life -= dt
				if (
					shard.vy > 0 &&
					shard.x > paddle.left &&
					shard.x < paddle.right &&
					shard.y > paddle.top &&
					shard.y < paddle.bottom
				) {
					shard.y = paddle.top
					shard.vy = -shard.vy * 0.4 - 60
					shard.vx += paddle.vx * 0.25
					shard.spin = -shard.spin
				}
			}
			shards = shards.filter((shard) => shard.life > 0 && shard.y < floor + 40)
			for (const entry of popups) {
				entry.life -= dt
				entry.y -= 40 * dt
			}
			popups = popups.filter((entry) => entry.life > 0)
			for (const ring of rings) {
				ring.life -= dt
				ring.radius += ring.growth * dt
			}
			rings = rings.filter((ring) => ring.life > 0)
			shake = Math.max(0, shake - dt * 40)
		},

		/**
		 * Draw shards and rings. Leaves the context in CSS-pixel space shifted
		 * by `offset` so the caller can draw the paddle and balls on top.
		 * @param {CanvasRenderingContext2D} ctx
		 * @param {number} dpr
		 * @param {{ x: number, y: number }} offset
		 */
		drawDebris(ctx, dpr, offset) {
			for (const shard of shards) {
				const fade = shard.life / shard.maxLife
				const size = 0.35 + 0.65 * fade
				const cos = Math.cos(shard.angle) * size * dpr
				const sin = Math.sin(shard.angle) * size * dpr
				ctx.globalAlpha = clamp(fade * 1.5, 0, 1)
				ctx.setTransform(
					cos,
					sin,
					-sin,
					cos,
					(shard.x + offset.x) * dpr,
					(shard.y + offset.y) * dpr,
				)
				if ('texture' in shard.fill) {
					ctx.drawImage(
						shard.fill.texture,
						shard.sx,
						shard.sy,
						shard.w * dpr,
						shard.h * dpr,
						-shard.w / 2,
						-shard.h / 2,
						shard.w,
						shard.h,
					)
				} else {
					ctx.fillStyle = shard.fill.color
					ctx.fillRect(-shard.w / 2, -shard.h / 2, shard.w, shard.h)
				}
			}
			ctx.globalAlpha = 1
			ctx.setTransform(dpr, 0, 0, dpr, offset.x * dpr, offset.y * dpr)
			ctx.lineWidth = 3
			for (const ring of rings) {
				ctx.strokeStyle = ring.color
				ctx.globalAlpha = clamp(ring.life / ringLife, 0, 1)
				ctx.beginPath()
				ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2)
				ctx.stroke()
			}
			ctx.globalAlpha = 1
		},

		/** @param {CanvasRenderingContext2D} ctx */
		drawPopups(ctx) {
			ctx.textAlign = 'center'
			ctx.textBaseline = 'middle'
			ctx.font = `700 14px ${fontFamily}`
			for (const entry of popups) {
				ctx.globalAlpha = clamp(entry.life, 0, 1)
				ctx.fillStyle = entry.color
				ctx.fillText(entry.text, entry.x, entry.y)
			}
			ctx.globalAlpha = 1
		},
	}
}

/**
 * Paint a word the way the page shows it so its shards carry real glyphs.
 * @param {HTMLElement} el
 * @param {Rect} rect
 * @param {number} scale page scale applied to `main`
 * @param {number} dpr
 * @returns {HTMLCanvasElement | null}
 */
export function wordTexture(el, rect, scale, dpr) {
	const style = getComputedStyle(el)
	const width = rect.right - rect.left
	const height = rect.bottom - rect.top
	const texture = document.createElement('canvas')
	texture.width = Math.max(1, Math.ceil(width * dpr))
	texture.height = Math.max(1, Math.ceil(height * dpr))
	const context = texture.getContext('2d')
	if (!context) return null
	context.scale(dpr, dpr)
	const fontSize = parseFloat(style.fontSize) * scale
	context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`
	context.fillStyle = style.color
	context.textBaseline = 'middle'
	context.fillText(el.textContent ?? '', 0, height / 2 + 0.5)
	return texture
}

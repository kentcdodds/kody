/* oxlint-disable no-undef -- browser module served from public/; the lint
   config's browser env does not apply here. */
import { createEffects, wordTexture } from './status-breakout-effects.js'
import { createHud } from './status-breakout-hud.js'
import {
	clamp,
	collideCircleRect,
	normalizeVelocity,
	paddleBounce,
	reflect,
	subStepCount,
} from './status-breakout-physics.js'

const statusPollMs = 20_000
const maxBalls = 3
const startingLives = 3
const blastRadius = 60
const ballRadius = 7
const paddleHeight = 12
const shellSelector =
	'.card, .banner, .incident, .provider-incident, .provider-section'
const points = { word: 10, dot: 25, bar: 5, explosive: 40, multiball: 40 }

/**
 * Bars ripple into their neighbors; red incident days explode; amber partial
 * days split off another ball.
 * @typedef {'word' | 'dot' | 'bar' | 'explosive' | 'multiball'} BrickKind
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{ x: number, y: number, vx: number, vy: number }} Impact
 * @typedef {{ el: HTMLElement, remaining: number, parent: Shell | null, alive: boolean }} Shell
 * @typedef {{ el: HTMLElement, kind: BrickKind, rect: Rect, alive: boolean, shell: Shell | null, prev: Brick | null, next: Brick | null }} Brick
 * @typedef {{ x: number, y: number, vx: number, vy: number, trail: Array<{ x: number, y: number }> }} Ball
 */

/**
 * Run Breakout over `main`, whose words are already wrapped in
 * `.brick-word` spans and which is already scaled into the playfield.
 * Leaf elements (words, status dots, day bars) are the bricks. Their
 * containers (cards, the banner, incidents) shatter on their own once the
 * last brick inside them breaks.
 * @param {HTMLElement} main
 * @param {{ scale: number, refit: () => number, reducedMotion: boolean }} options
 */
export function createGame(
	main,
	{ scale: initialScale, refit, reducedMotion },
) {
	const canvas = document.createElement('canvas')
	canvas.className = 'breakout-canvas'
	canvas.setAttribute('aria-hidden', 'true')
	const context = canvas.getContext('2d')
	if (!context) return
	const ctx = context
	document.body.append(canvas)

	const rootStyle = getComputedStyle(document.documentElement)
	/** @param {string} name @param {string} fallback */
	const cssVar = (name, fallback) =>
		rootStyle.getPropertyValue(name).trim() || fallback
	const palette = {
		text: cssVar('--text', '#0f172a'),
		muted: cssVar('--muted', '#64748b'),
		down: cssVar('--down', '#dc2626'),
		ok: cssVar('--ok', '#16a34a'),
		partial: cssVar('--partial', '#d97706'),
	}
	const fontFamily = getComputedStyle(document.body).fontFamily
	const effects = createEffects({ reducedMotion, fontFamily })
	const hud = createHud({ onQuit: quit })

	let scale = initialScale
	let width = innerWidth
	let height = innerHeight
	let dpr = 1
	let baseSpeed = 520
	let speed = baseSpeed
	/** @type {Array<Brick>} */
	let bricks = []
	let remainingBricks = 0
	/** @type {Array<Ball>} */
	let balls = []
	/** @type {Array<{ at: number, run: () => void }>} */
	let pending = []
	const paddle = { x: innerWidth / 2, y: 0, width: 120, targetX: 0, vx: 0 }
	paddle.targetX = paddle.x
	let keyDirection = 0
	let lives = startingLives
	let score = 0
	let combo = 0
	let elapsed = 0
	/** @type {'serve' | 'play' | 'paused' | 'over' | 'won'} */
	let state = 'serve'
	let liveStatus = document.body.dataset.overallStatus ?? 'unknown'
	let lastFrame = performance.now()

	resize()
	collectBricks()
	serveBall()
	void pollStatus()
	const originalTitle = document.title
	setInterval(() => void pollStatus(), statusPollMs)
	bindInput()
	requestAnimationFrame(frame)

	function bindInput() {
		addEventListener('resize', () => {
			scale = refit()
			resize()
			for (const brick of bricks) brick.rect = measure(brick.el)
		})
		canvas.addEventListener('pointermove', (event) => {
			paddle.targetX = event.clientX
		})
		canvas.addEventListener('pointerdown', (event) => {
			paddle.targetX = event.clientX
			launchOrResume()
		})
		addEventListener('keydown', (event) => {
			const activatesButton = event.key === ' ' || event.key === 'Enter'
			if (activatesButton && event.target instanceof HTMLButtonElement) return
			if (event.key === 'ArrowLeft' || event.key === 'a') keyDirection = -1
			else if (event.key === 'ArrowRight' || event.key === 'd') {
				keyDirection = 1
			} else if (event.key === ' ' || event.key === 'ArrowUp') {
				launchOrResume()
			} else if (event.key === 'p') togglePause()
			else if (event.key === 'Escape') quit()
			else return
			event.preventDefault()
		})
		addEventListener('keyup', (event) => {
			const left = event.key === 'ArrowLeft' || event.key === 'a'
			const right = event.key === 'ArrowRight' || event.key === 'd'
			if ((left && keyDirection < 0) || (right && keyDirection > 0)) {
				keyDirection = 0
			}
		})
		document.addEventListener('visibilitychange', () => {
			if (document.hidden && state === 'play') state = 'paused'
		})
	}

	function resize() {
		dpr = Math.min(devicePixelRatio || 1, 2)
		width = innerWidth
		height = innerHeight
		canvas.width = Math.round(width * dpr)
		canvas.height = Math.round(height * dpr)
		canvas.style.width = `${width}px`
		canvas.style.height = `${height}px`
		paddle.width = clamp(width * 0.16, 90, 170)
		paddle.y = Math.min(height - 64, hud.top() - paddleHeight - 16)
		paddle.x = clamp(paddle.x, paddle.width / 2, width - paddle.width / 2)
		baseSpeed = clamp(height * 0.75, 420, 720)
		speed = Math.max(speed, baseSpeed)
	}

	function paddleRect() {
		return {
			left: paddle.x - paddle.width / 2,
			right: paddle.x + paddle.width / 2,
			top: paddle.y,
			bottom: paddle.y + paddleHeight,
			vx: paddle.vx,
		}
	}

	function collectBricks() {
		/** @type {Map<Element, Shell>} */
		const shells = new Map()
		/** @param {Element | null} from @returns {Shell | null} */
		const shellFor = (from) => {
			const el = from?.closest(shellSelector)
			if (!(el instanceof HTMLElement) || !main.contains(el)) return null
			const existing = shells.get(el)
			if (existing) return existing
			/** @type {Shell} */
			const shell = {
				el,
				remaining: 0,
				parent: shellFor(el.parentElement),
				alive: true,
			}
			if (shell.parent) shell.parent.remaining++
			shells.set(el, shell)
			return shell
		}
		/** @type {Map<Element, Brick>} */
		const byElement = new Map()
		bricks = []
		for (const el of main.querySelectorAll('.brick-word, .bar, .dot')) {
			if (!(el instanceof HTMLElement)) continue
			const rect = measure(el)
			if (rect.right - rect.left < 0.5 || rect.bottom - rect.top < 0.5) {
				continue
			}
			const shell = shellFor(el.parentElement)
			if (shell) shell.remaining++
			/** @type {Brick} */
			const brick = {
				el,
				kind: brickKind(el),
				rect,
				alive: true,
				shell,
				prev: null,
				next: null,
			}
			bricks.push(brick)
			byElement.set(el, brick)
		}
		for (const brick of bricks) {
			if (!brick.el.classList.contains('bar')) continue
			const prev = brick.el.previousElementSibling
			const next = brick.el.nextElementSibling
			brick.prev = prev ? (byElement.get(prev) ?? null) : null
			brick.next = next ? (byElement.get(next) ?? null) : null
		}
		remainingBricks = bricks.length
	}

	function serveBall() {
		speed = baseSpeed
		balls = [{ x: paddle.x, y: paddle.y - 8, vx: 0, vy: 0, trail: [] }]
		state = 'serve'
	}

	function launchOrResume() {
		if (state === 'paused') {
			state = 'play'
			return
		}
		if (state !== 'serve') return
		const angle = (Math.random() - 0.5) * 0.7
		for (const ball of balls) {
			ball.vx = Math.sin(angle) * speed
			ball.vy = -Math.cos(angle) * speed
		}
		state = 'play'
	}

	function togglePause() {
		if (state === 'play') state = 'paused'
		else if (state === 'paused') state = 'play'
	}

	function quit() {
		location.reload()
	}

	/** @param {number} delay seconds of play time @param {() => void} run */
	function schedule(delay, run) {
		pending.push({ at: elapsed + delay, run })
	}

	/**
	 * @param {Brick} brick
	 * @param {Impact} impact
	 * @param {'ball' | 'ripple' | 'blast'} cause
	 */
	function destroy(brick, impact, cause) {
		if (!brick.alive) return
		brick.alive = false
		remainingBricks--
		brick.el.style.visibility = 'hidden'
		const texture =
			brick.kind === 'word'
				? wordTexture(brick.el, brick.rect, scale, dpr)
				: null
		effects.shatter(
			brick.rect,
			impact,
			texture
				? { texture }
				: { color: getComputedStyle(brick.el).backgroundColor },
			texture
				? { pieceSize: 5, maxPieces: 28, dpr }
				: { pieceSize: 4, maxPieces: 10, dpr },
		)
		score += points[brick.kind] * (1 + Math.floor(combo / 8))
		const center = centerOf(brick.rect)
		switch (brick.kind) {
			case 'bar': {
				if (cause !== 'ball') break
				for (const neighbor of [brick.prev, brick.next]) {
					if (neighbor) {
						schedule(0.04, () => destroy(neighbor, impact, 'ripple'))
					}
				}
				break
			}
			case 'explosive': {
				explode(center.x, center.y)
				break
			}
			case 'multiball': {
				spawnBall(center.x, center.y)
				break
			}
			case 'word':
			case 'dot':
				break
			default: {
				/** @type {never} */
				const unhandled = brick.kind
				throw new Error(`Unknown brick kind: ${String(unhandled)}`)
			}
		}
		if (brick.shell) shellChildGone(brick.shell)
	}

	/** @param {number} x @param {number} y */
	function explode(x, y) {
		effects.ring(x, y, blastRadius, palette.down)
		effects.addShake(9)
		effects.popup(x, y, 'Incident day!', palette.down)
		for (const other of bricks) {
			if (!other.alive) continue
			const center = centerOf(other.rect)
			const distance = Math.hypot(center.x - x, center.y - y)
			if (distance > blastRadius) continue
			schedule(distance / 900, () =>
				destroy(other, { x, y, vx: 0, vy: 0 }, 'blast'),
			)
		}
	}

	/** @param {number} x @param {number} y */
	function spawnBall(x, y) {
		if (balls.length >= maxBalls) return
		const angle = (Math.random() - 0.5) * 1.6
		balls.push({
			x,
			y,
			vx: Math.sin(angle) * speed,
			vy: -Math.cos(angle) * speed,
			trail: [],
		})
		effects.popup(x, y, 'Multiball', palette.partial)
	}

	/** @param {Shell} shell */
	function shellChildGone(shell) {
		shell.remaining--
		if (shell.remaining > 0 || !shell.alive) return
		schedule(0.14, () => shatterShell(shell))
	}

	/** @param {Shell} shell */
	function shatterShell(shell) {
		if (!shell.alive) return
		shell.alive = false
		const style = getComputedStyle(shell.el)
		const rect = measure(shell.el)
		const hasBackground =
			style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
			style.backgroundColor !== 'transparent'
		const surface = hasBackground
			? rect
			: {
					...rect,
					right: rect.left + parseFloat(style.borderLeftWidth) * scale,
				}
		const center = centerOf(rect)
		shell.el.style.visibility = 'hidden'
		effects.shatter(
			surface,
			{ ...center, vx: 0, vy: 0 },
			{
				color: hasBackground ? style.backgroundColor : style.borderLeftColor,
			},
			{ pieceSize: 16, maxPieces: 80, dpr },
		)
		score += 100
		effects.addShake(6)
		effects.popup(center.x, center.y, '+100', palette.text)
		if (shell.parent) shellChildGone(shell.parent)
	}

	/** @param {number} now */
	function frame(now) {
		const dt = Math.min((now - lastFrame) / 1000, 1 / 30)
		lastFrame = now
		if (state === 'play') {
			elapsed += dt
			runPending()
			updatePaddle(dt)
			// Bricks hit this frame can spawn balls; those must survive the filter.
			const count = balls.length
			const survivors = balls
				.slice(0, count)
				.filter((ball) => updateBall(ball, dt))
			balls = [...survivors, ...balls.slice(count)]
			if (remainingBricks === 0 && pending.length === 0) finish('won')
			else if (balls.length === 0 && pending.length === 0) loseLife()
		} else if (state === 'serve') {
			updatePaddle(dt)
			for (const ball of balls) {
				ball.x = paddle.x
				ball.y = paddle.y - ballRadius - 1
			}
		}
		if (state !== 'paused') effects.update(dt, paddleRect(), height)
		draw()
		hud.setScore(score)
		hud.setLives(lives)
		requestAnimationFrame(frame)
	}

	function runPending() {
		const due = pending.filter((entry) => entry.at <= elapsed)
		if (due.length === 0) return
		pending = pending.filter((entry) => entry.at > elapsed)
		for (const entry of due) entry.run()
	}

	/** @param {number} dt */
	function updatePaddle(dt) {
		paddle.targetX = clamp(
			paddle.targetX + keyDirection * 950 * dt,
			paddle.width / 2,
			width - paddle.width / 2,
		)
		const nextX = paddle.x + (paddle.targetX - paddle.x) * Math.min(1, dt * 22)
		paddle.vx = dt > 0 ? (nextX - paddle.x) / dt : 0
		paddle.x = nextX
	}

	/** @param {Ball} ball @param {number} dt @returns {boolean} still in play */
	function updateBall(ball, dt) {
		ball.trail.push({ x: ball.x, y: ball.y })
		if (ball.trail.length > 12) ball.trail.shift()
		const steps = subStepCount(Math.hypot(ball.vx, ball.vy) * dt, ballRadius)
		const step = dt / steps
		const paddleBody = paddleRect()
		for (let index = 0; index < steps; index++) {
			ball.x += ball.vx * step
			ball.y += ball.vy * step
			if (ball.x - ballRadius < 0) {
				ball.x = ballRadius
				ball.vx = Math.abs(ball.vx)
			} else if (ball.x + ballRadius > width) {
				ball.x = width - ballRadius
				ball.vx = -Math.abs(ball.vx)
			}
			if (ball.y - ballRadius < 0) {
				ball.y = ballRadius
				ball.vy = Math.abs(ball.vy)
			}
			if (ball.y - ballRadius > height) return false
			if (
				ball.vy > 0 &&
				ball.y < paddle.y + paddleHeight / 2 &&
				collideCircleRect(ball.x, ball.y, ballRadius, paddleBody)
			) {
				const bounce = paddleBounce({
					offset: (ball.x - paddle.x) / (paddle.width / 2),
					paddleVelocity: paddle.vx,
					speed,
				})
				ball.vx = bounce.vx
				ball.vy = bounce.vy
				ball.y = paddle.y - ballRadius - 0.5
				combo = 0
			}
			collideBricks(ball)
		}
		return true
	}

	/** A ball breaks every brick it touches but bounces once per sub-step.
	 * @param {Ball} ball */
	function collideBricks(ball) {
		let bounced = false
		for (const brick of bricks) {
			if (!brick.alive) continue
			const rect = brick.rect
			if (
				ball.x + ballRadius < rect.left ||
				ball.x - ballRadius > rect.right ||
				ball.y + ballRadius < rect.top ||
				ball.y - ballRadius > rect.bottom
			) {
				continue
			}
			const contact = collideCircleRect(ball.x, ball.y, ballRadius, rect)
			if (!contact) continue
			combo++
			destroy(brick, { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy }, 'ball')
			if (bounced) continue
			bounced = true
			speed = Math.min(baseSpeed * 1.45, speed + 2)
			const reflected = reflect(ball.vx, ball.vy, contact.nx, contact.ny)
			const next = normalizeVelocity(reflected.vx, reflected.vy, speed)
			ball.vx = next.vx
			ball.vy = next.vy
			ball.x += contact.nx * contact.depth
			ball.y += contact.ny * contact.depth
		}
	}

	function loseLife() {
		lives--
		combo = 0
		if (lives <= 0) {
			finish('over')
			return
		}
		effects.addShake(5)
		serveBall()
	}

	function draw() {
		const offset = effects.shakeOffset()
		main.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.clearRect(0, 0, canvas.width, canvas.height)
		effects.drawDebris(ctx, dpr, offset)

		ctx.fillStyle = palette.text
		ctx.shadowColor = palette.text
		ctx.shadowBlur = 12
		ctx.beginPath()
		ctx.roundRect(
			paddle.x - paddle.width / 2,
			paddle.y,
			paddle.width,
			paddleHeight,
			paddleHeight / 2,
		)
		ctx.fill()

		for (const ball of balls) {
			ctx.shadowBlur = 0
			if (!reducedMotion) {
				ball.trail.forEach((point, index) => {
					const progress = index / ball.trail.length
					ctx.globalAlpha = progress * 0.35
					ctx.beginPath()
					ctx.arc(point.x, point.y, ballRadius * progress, 0, Math.PI * 2)
					ctx.fill()
				})
			}
			ctx.globalAlpha = 1
			ctx.shadowColor = liveStatus === 'operational' ? palette.ok : palette.down
			ctx.shadowBlur = 18
			ctx.beginPath()
			ctx.arc(ball.x, ball.y, ballRadius, 0, Math.PI * 2)
			ctx.fill()
		}
		ctx.shadowBlur = 0
		effects.drawPopups(ctx)

		const hint =
			state === 'serve'
				? 'Click, tap, or press Space to launch'
				: state === 'paused'
					? 'Paused. Click or press Space to resume'
					: ''
		if (hint) {
			ctx.fillStyle = palette.muted
			ctx.font = `600 15px ${fontFamily}`
			ctx.fillText(hint, width / 2, paddle.y - 48)
		}
	}

	/** @param {'won' | 'over'} result */
	function finish(result) {
		state = result
		const seconds = Math.round(elapsed)
		const time =
			seconds >= 60
				? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
				: `${seconds}s`
		hud.showPanel(
			result === 'won' ? 'You broke the whole page' : 'Out of balls',
			`Score ${score.toLocaleString()} in ${time}.`,
			{ onPlayAgain: restart },
		)
	}

	function restart() {
		for (const hidden of main.querySelectorAll('[style*="visibility"]')) {
			if (hidden instanceof HTMLElement) hidden.style.visibility = ''
		}
		pending = []
		lives = startingLives
		score = 0
		combo = 0
		elapsed = 0
		collectBricks()
		serveBall()
	}

	async function pollStatus() {
		let next = 'unreachable'
		try {
			const response = await fetch('/status.json', { cache: 'no-store' })
			if (response.ok) {
				const snapshot = await response.json()
				next = String(snapshot.overallStatus)
			}
		} catch {
			next = 'unreachable'
		}
		const wasOperational = liveStatus === 'operational'
		const isOperational = next === 'operational'
		liveStatus = next
		hud.setLiveStatus(next, new Date())
		if (!wasOperational && isOperational) {
			document.title = 'Kody is back · Kody status'
			hud.showRecovered()
		} else if (wasOperational && !isOperational) {
			document.title = originalTitle
			hud.hideRecovered()
		}
	}
}

/** @param {HTMLElement} el @returns {BrickKind} */
function brickKind(el) {
	if (el.classList.contains('dot')) return 'dot'
	if (!el.classList.contains('bar')) return 'word'
	if (el.classList.contains('bad')) return 'explosive'
	if (el.classList.contains('partial')) return 'multiball'
	return 'bar'
}

/** @param {Element} el @returns {Rect} */
function measure(el) {
	const rect = el.getBoundingClientRect()
	return {
		left: rect.left,
		top: rect.top,
		right: rect.right,
		bottom: rect.bottom,
	}
}

/** @param {Rect} rect */
function centerOf(rect) {
	return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
}

import { expect, test } from 'vitest'
import {
	collideCircleRect,
	normalizeVelocity,
	paddleBounce,
	reflect,
	shardGrid,
	subStepCount,
} from './public/status-breakout-physics.js'

const brick = { left: 100, top: 100, right: 140, bottom: 110 }

test('a ball striking a brick face bounces straight back off that face', () => {
	const fromBelow = collideCircleRect(120, 114, 6, brick)
	expect(fromBelow).toEqual({ nx: 0, ny: 1, depth: 2 })
	expect(reflect(30, -400, 0, 1)).toEqual({ vx: 30, vy: 400 })

	const fromLeft = collideCircleRect(96, 105, 6, brick)
	expect(fromLeft).toEqual({ nx: -1, ny: 0, depth: 2 })

	expect(collideCircleRect(120, 130, 6, brick)).toBeNull()
})

test('a corner hit deflects diagonally and a ball already leaving is not flipped back', () => {
	const corner = collideCircleRect(143, 113, 6, brick)
	expect(corner?.nx).toBeCloseTo(Math.SQRT1_2)
	expect(corner?.ny).toBeCloseTo(Math.SQRT1_2)
	const bounced = reflect(-300, -300, Math.SQRT1_2, Math.SQRT1_2)
	expect(bounced.vx).toBeCloseTo(300)
	expect(bounced.vy).toBeCloseTo(300)

	expect(reflect(0, 400, 0, 1)).toEqual({ vx: 0, vy: 400 })
})

test('a ball buried inside a brick is pushed out through the nearest face', () => {
	expect(collideCircleRect(120, 102, 6, brick)).toEqual({
		nx: 0,
		ny: -1,
		depth: 8,
	})
})

test('paddle edges steer the ball and every bounce leaves upward at the same speed', () => {
	const center = paddleBounce({ offset: 0, paddleVelocity: 0, speed: 500 })
	expect(center.vx).toBeCloseTo(0)
	expect(center.vy).toBeCloseTo(-500)

	const rightEdge = paddleBounce({ offset: 1, paddleVelocity: 0, speed: 500 })
	expect(rightEdge.vx).toBeGreaterThan(400)
	expect(rightEdge.vy).toBeLessThan(0)
	expect(Math.hypot(rightEdge.vx, rightEdge.vy)).toBeCloseTo(500)

	const flicked = paddleBounce({
		offset: -1,
		paddleVelocity: -5000,
		speed: 500,
	})
	expect(flicked.vy).toBeLessThan(-140)
	expect(Math.hypot(flicked.vx, flicked.vy)).toBeCloseTo(500)
})

test('a nearly horizontal ball is tilted so it cannot ping-pong between walls forever', () => {
	const next = normalizeVelocity(500, 1, 500)
	expect(Math.abs(next.vy)).toBeCloseTo(150)
	expect(Math.hypot(next.vx, next.vy)).toBeCloseTo(500)
})

test('fast balls take small enough sub-steps to hit 2px day bars', () => {
	expect(subStepCount(24, 7)).toBe(7)
	expect(subStepCount(0, 7)).toBe(1)
})

test('shards tile the shattered element exactly and respect the piece cap', () => {
	const pieces = shardGrid(40, 10, 5, 100)
	expect(pieces).toHaveLength(16)
	const area = pieces.reduce((sum, piece) => sum + piece.w * piece.h, 0)
	expect(area).toBeCloseTo(400)

	expect(shardGrid(400, 200, 4, 80).length).toBeLessThanOrEqual(80)
	expect(shardGrid(2, 2000, 16, 80).length).toBeLessThanOrEqual(80)
	expect(shardGrid(0, 10, 4, 80)).toEqual([])
})

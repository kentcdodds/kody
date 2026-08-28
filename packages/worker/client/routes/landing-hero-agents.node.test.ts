import { expect, test } from 'vitest'
import {
	listAllWalkthroughHosts,
	pickWalkthroughHosts,
} from '#universal/walkthrough-hosts.ts'
import {
	landingHeroLightAt,
	landingHeroLightProximity,
	landingHeroLightRate,
	landingHeroLightRateFar,
	landingHeroLightRateNear,
	landingHeroPinnedHostIds,
	landingHeroSlots,
	pickLandingHeroRing,
	placeLandingHeroAgents,
} from './landing-hero-agents.tsx'

test('hero ring always includes the pinned hosts and fills leftover slots from the SSR shuffle', () => {
	const catalog = listAllWalkthroughHosts()
	expect(landingHeroSlots.length).toBeLessThan(catalog.length)

	const fallback = placeLandingHeroAgents()
	expect(fallback.map((agent) => ({ x: agent.x, y: agent.y }))).toEqual(
		landingHeroSlots.map((slot) => ({ x: slot.x, y: slot.y })),
	)
	for (const id of landingHeroPinnedHostIds) {
		const host = catalog.find((entry) => entry.id === id)
		expect(host).toBeDefined()
		expect(fallback.some((agent) => agent.label === host?.label)).toBe(true)
	}

	const pick = pickWalkthroughHosts(() => 0)
	const placed = placeLandingHeroAgents(pick)
	expect(placed).toHaveLength(landingHeroSlots.length)
	for (const id of landingHeroPinnedHostIds) {
		const host = catalog.find((entry) => entry.id === id)
		expect(host).toBeDefined()
		expect(placed.some((agent) => agent.label === host?.label)).toBe(true)
	}

	const pinnedLast = [
		...catalog.filter(
			(host) =>
				!(landingHeroPinnedHostIds as ReadonlyArray<string>).includes(host.id),
		),
		...catalog.filter((host) =>
			(landingHeroPinnedHostIds as ReadonlyArray<string>).includes(host.id),
		),
	]
	const fromPinnedLast = pickLandingHeroRing(pinnedLast)
	expect(fromPinnedLast).toHaveLength(landingHeroSlots.length)
	for (const id of landingHeroPinnedHostIds) {
		expect(fromPinnedLast.some((host) => host.id === id)).toBe(true)
	}
	expect(fromPinnedLast.map((host) => host.id)).not.toEqual(
		pinnedLast.slice(0, landingHeroSlots.length).map((host) => host.id),
	)
})

test('hero tether lights travel inbound to the lantern and outbound to the agent', () => {
	const agent = { cycle: 4, phase: 0, travel: 1 }
	const inboundStart = landingHeroLightAt(agent, 0, 'in')
	expect(inboundStart).toMatchObject({ progress: 0, scale: 1 })
	const inboundMid = landingHeroLightAt(agent, 0.5, 'in')
	expect(inboundMid).not.toBeNull()
	expect(inboundMid!.progress).toBeGreaterThan(0)
	expect(inboundMid!.progress).toBeLessThan(1)
	expect(inboundMid!.scale).toBeLessThan(1)
	expect(landingHeroLightAt(agent, 1.2, 'in')).toBeNull()

	const outboundStart = landingHeroLightAt(agent, 4 - agent.cycle * 0.42, 'out')
	expect(outboundStart).toMatchObject({ progress: 1, scale: 0.45 })
	const outboundMid = landingHeroLightAt(
		agent,
		4 - agent.cycle * 0.42 + 0.5,
		'out',
	)
	expect(outboundMid).not.toBeNull()
	expect(outboundMid!.progress).toBeGreaterThan(0)
	expect(outboundMid!.progress).toBeLessThan(1)
	expect(outboundMid!.scale).toBeGreaterThan(0.45)
	expect(landingHeroLightRate(0.5)).toBeGreaterThan(landingHeroLightRateFar)
	expect(landingHeroLightRate(0.5)).toBeLessThan(landingHeroLightRateNear)
	expect(
		landingHeroLightProximity({
			lantern: { x: 100, y: 100 },
			pointer: { x: 100, y: 100 },
			viewport: { width: 800, height: 600 },
			finePointer: true,
		}),
	).toBe(1)
	expect(
		landingHeroLightProximity({
			lantern: { x: 100, y: 100 },
			pointer: null,
			viewport: { width: 800, height: 600 },
			finePointer: true,
		}),
	).toBe(0)
	expect(
		landingHeroLightProximity({
			lantern: { x: 400, y: 300 },
			pointer: null,
			viewport: { width: 800, height: 600 },
			finePointer: false,
		}),
	).toBe(1)
	expect(
		landingHeroLightProximity({
			lantern: { x: 0, y: 0 },
			pointer: null,
			viewport: { width: 800, height: 600 },
			finePointer: false,
		}),
	).toBeLessThan(0.5)
})

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { onboardingMobileFeaturedAgentIds } from './onboarding-mcp-clients.ts'
import {
	isValidWalkthroughHostPick,
	joinWalkthroughHostLabels,
	listAllWalkthroughHosts,
	listChatWalkthroughHosts,
	listCodingWalkthroughHosts,
	listValidWalkthroughHostPicks,
	listWalkthroughConversationHosts,
	listWalkthroughHostOptions,
	pickWalkthroughHosts,
	replaceWalkthroughHost,
	resolveWalkthroughKicker,
	shuffleWalkthroughHosts,
	walkthroughHostCatalog,
	walkthroughHostForAct,
	walkthroughHostMarkUrl,
} from './walkthrough-hosts.ts'

const walkthroughIconDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../public/images/icons',
)

test('every valid pick is a coding host, a chat host, and a third host of either kind from three companies', () => {
	const picks = listValidWalkthroughHostPicks()
	const codingRow = listCodingWalkthroughHosts()
	const chatRow = listChatWalkthroughHosts()
	const allRow = listAllWalkthroughHosts()
	expect(picks.length).toBeGreaterThan(0)
	const ids = (hosts: Array<{ id: string }>) => hosts.map((host) => host.id)
	expect(ids(codingRow)).toEqual(
		expect.arrayContaining([
			'grok-bot',
			'muse',
			'wajo',
			'cue',
			'openmuse',
			'dots',
		]),
	)
	expect(ids(chatRow)).toContain('grok-bot')
	expect(ids(allRow)).toEqual(
		expect.arrayContaining(['muse', 'wajo', 'cue', 'openmuse', 'dots']),
	)
	expect(
		walkthroughHostCatalog.find((host) => host.id === 'muse'),
	).toMatchObject({
		label: 'Muse',
		icon: 'muse',
		company: 'meta',
		kind: 'coding',
	})
	expect(
		walkthroughHostCatalog.find((host) => host.id === 'openmuse'),
	).toMatchObject({
		label: 'OpenMuse',
		icon: 'openmuse',
		company: 'copilotkit',
		kind: 'coding',
	})
	expect(
		walkthroughHostCatalog.find((host) => host.id === 'wajo'),
	).toMatchObject({
		label: 'Wajo',
		icon: 'wajo',
		company: 'wajo',
		kind: 'coding',
	})
	expect(
		walkthroughHostCatalog.find((host) => host.id === 'cue'),
	).toMatchObject({
		label: 'Cue',
		icon: 'cue',
		company: 'cue',
		kind: 'coding',
	})
	expect(
		walkthroughHostCatalog.find((host) => host.id === 'dots'),
	).toMatchObject({
		label: 'Dots',
		icon: 'dots',
		company: 'openai',
		kind: 'coding',
	})
	expect(ids(picks.map((pick) => pick.coding))).toEqual(
		expect.arrayContaining([
			'muse',
			'grok-bot',
			'wajo',
			'cue',
			'openmuse',
			'dots',
		]),
	)
	expect(ids(picks.map((pick) => pick.invoke))).toContain('grok-bot')
	expect(
		picks.some(
			(pick) => pick.coding.id === 'grok-bot' && pick.invoke.id === 'grok-bot',
		),
	).toBe(false)
	expect(picks.map((pick) => pick.notify.kind)).toEqual(
		expect.arrayContaining(['coding', 'chat']),
	)
	for (const pick of picks) {
		expect(
			isValidWalkthroughHostPick({ ...pick, codingRow, chatRow, allRow }),
		).toBe(true)
	}
	expect(
		picks.some(
			(pick) =>
				pick.coding.id === 'cursor' &&
				(pick.invoke.id === 'grok' ||
					pick.invoke.id === 'grok-bot' ||
					pick.notify.id === 'grok' ||
					pick.notify.id === 'grok-bot'),
		),
	).toBe(false)
	expect(
		picks.some(
			(pick) =>
				pick.coding.id === 'claude-code' &&
				(pick.invoke.id === 'claude' || pick.notify.id === 'claude'),
		),
	).toBe(false)
	expect(
		picks.some(
			(pick) =>
				pick.coding.id === 'codex' &&
				(pick.invoke.id === 'chatgpt' || pick.notify.id === 'chatgpt'),
		),
	).toBe(false)
	expect(
		picks.some(
			(pick) =>
				(pick.invoke.id === 'grok' && pick.notify.id === 'grok-bot') ||
				(pick.invoke.id === 'grok-bot' && pick.notify.id === 'grok'),
		),
	).toBe(false)
	expect(
		walkthroughHostCatalog
			.filter(
				(host) => !existsSync(join(walkthroughIconDir, `${host.icon}.svg`)),
			)
			.map((host) => host.icon),
	).toEqual([])
})

test('phone slot offers chat apps plus coding hosts with a real phone surface', () => {
	const phoneIds = listChatWalkthroughHosts().map((host) => host.id)
	expect([...phoneIds].sort()).toEqual([
		'chatgpt',
		'claude',
		'claude-code',
		'codex',
		'copilot',
		'cursor',
		'devin',
		'gemini',
		'grok',
		'grok-bot',
		'openclaw',
	])
	expect(listCodingWalkthroughHosts().map((host) => host.id)).toEqual(
		expect.arrayContaining([
			'claude-code',
			'codex',
			'copilot',
			'cursor',
			'devin',
			'openclaw',
		]),
	)

	const walkthroughIdByMobileAgent = {
		chatgpt: 'chatgpt',
		'claude-desktop': 'claude',
		'copilot-app': 'copilot',
		gemini: 'gemini',
		grok: 'grok',
		'grok-bot': 'grok-bot',
	} as const satisfies Record<
		(typeof onboardingMobileFeaturedAgentIds)[number],
		string
	>
	for (const id of onboardingMobileFeaturedAgentIds) {
		expect(phoneIds).toContain(walkthroughIdByMobileAgent[id])
	}

	const pick = replaceWalkthroughHost(
		replaceWalkthroughHost(
			replaceWalkthroughHost(
				pickWalkthroughHosts(() => 0),
				'coding',
				'dots',
			),
			'invoke',
			'gemini',
		),
		'notify',
		'claude',
	)
	expect(
		listWalkthroughHostOptions(pick, 'invoke').map((host) => host.label),
	).toEqual([
		'ChatGPT',
		'Claude Code',
		'Codex',
		'Copilot',
		'Cursor',
		'Devin',
		'Gemini',
		'Grok',
		'Grok Bot',
		'OpenClaw',
	])
})

test('pickWalkthroughHosts uses the injected rng, maps acts, and supports host replacement', () => {
	const picks = listValidWalkthroughHostPicks()
	const codingIds = listCodingWalkthroughHosts().map((host) => host.id)
	const chatIds = listChatWalkthroughHosts().map((host) => host.id)
	const first = pickWalkthroughHosts(() => 0)
	expect(picks).toContainEqual(
		expect.objectContaining({
			coding: first.coding,
			invoke: first.invoke,
			notify: first.notify,
		}),
	)
	expect(first.codingRow.map((host) => host.id).sort()).toEqual(
		[...codingIds].sort(),
	)
	expect(first.chatRow.map((host) => host.id).sort()).toEqual(
		[...chatIds].sort(),
	)
	expect(first.allRow.map((host) => host.id).sort()).toEqual(
		listAllWalkthroughHosts()
			.map((host) => host.id)
			.sort(),
	)

	const last = pickWalkthroughHosts(() => picks.length - 1)
	expect(picks).toContainEqual(
		expect.objectContaining({
			coding: last.coding,
			invoke: last.invoke,
			notify: last.notify,
		}),
	)

	const left = shuffleWalkthroughHosts(listCodingWalkthroughHosts(), () => 0)
	const right = shuffleWalkthroughHosts(
		listCodingWalkthroughHosts(),
		(max) => max - 1,
	)
	expect(left.map((host) => host.id)).not.toEqual(right.map((host) => host.id))
	expect(new Set(left.map((host) => host.id))).toEqual(new Set(codingIds))
	expect(new Set(right.map((host) => host.id))).toEqual(new Set(codingIds))

	const pick = first
	expect(walkthroughHostForAct(pick, 'ask')).toEqual(pick.coding)
	expect(walkthroughHostForAct(pick, 'invoke')).toEqual(pick.invoke)
	expect(walkthroughHostForAct(pick, 'notify')).toEqual(pick.notify)
	expect(walkthroughHostForAct(pick, 'discover')).toBeUndefined()
	expect(walkthroughHostForAct(undefined, 'ask')).toBeUndefined()
	expect(walkthroughHostMarkUrl(pick.coding)).toBe(
		`/images/icons/${pick.coding.icon}.svg`,
	)
	expect(listWalkthroughConversationHosts(pick).map((host) => host.id)).toEqual(
		[pick.coding.id, pick.invoke.id, pick.notify.id],
	)
	expect(
		listWalkthroughConversationHosts({
			...pick,
			notify: pick.coding,
		}).map((host) => host.id),
	).toEqual([pick.coding.id, pick.invoke.id])
	expect(
		[['Cursor'], ['Cursor', 'Claude'], ['Cursor', 'Claude', 'Grok']].map(
			joinWalkthroughHostLabels,
		),
	).toEqual(['Cursor', 'Cursor and Claude', 'Cursor, Claude, and Grok'])
	expect(
		resolveWalkthroughKicker('You start on the computer with {coding}.', pick),
	).toBe(`You start on the computer with ${pick.coding.label}.`)
	expect(resolveWalkthroughKicker('Later, on your phone with {invoke}.')).toBe(
		'Later, on your phone with {invoke}.',
	)

	const codingOptions = listWalkthroughHostOptions(pick, 'coding')
	expect(codingOptions.every((host) => host.id !== pick.invoke.id)).toBe(true)
	expect(codingOptions.every((host) => host.id !== pick.notify.id)).toBe(true)
	expect(codingOptions.some((host) => host.id === pick.coding.id)).toBe(true)
	expect(codingOptions.some((host) => host.id === 'gemini')).toBe(false)

	const nextCoding = codingOptions.find((host) => host.id !== pick.coding.id)
	expect(nextCoding).toBeDefined()
	const replaced = replaceWalkthroughHost(pick, 'coding', nextCoding!.id)
	expect(replaced.coding).toEqual(nextCoding)
	expect(replaced.invoke).toEqual(pick.invoke)
	expect(replaced.notify).toEqual(pick.notify)
	expect(replaceWalkthroughHost(pick, 'invoke', pick.coding.id)).toEqual(pick)
	expect(replaceWalkthroughHost(pick, 'notify', 'missing')).toEqual(pick)
})

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
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
	expect(
		listCodingWalkthroughHosts().some((host) => host.id === 'grok-bot'),
	).toBe(true)
	expect(
		listChatWalkthroughHosts().some((host) => host.id === 'grok-bot'),
	).toBe(true)
	expect(picks.some((pick) => pick.coding.id === 'grok-bot')).toBe(true)
	expect(picks.some((pick) => pick.invoke.id === 'grok-bot')).toBe(true)
	expect(
		picks.some(
			(pick) => pick.coding.id === 'grok-bot' && pick.invoke.id === 'grok-bot',
		),
	).toBe(false)
	expect(picks.some((pick) => pick.notify.kind === 'coding')).toBe(true)
	expect(picks.some((pick) => pick.notify.kind === 'chat')).toBe(true)
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
	expect(joinWalkthroughHostLabels(['Cursor'])).toBe('Cursor')
	expect(joinWalkthroughHostLabels(['Cursor', 'Claude'])).toBe(
		'Cursor and Claude',
	)
	expect(joinWalkthroughHostLabels(['Cursor', 'Claude', 'Grok'])).toBe(
		'Cursor, Claude, and Grok',
	)
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

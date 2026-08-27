/**
 * Hosts that can appear as the three conversations in the How Kody works
 * walkthrough (and the homepage factory loop). Coding hosts create the
 * package; invoke is a chat/phone host; notify can be either kind. Grok Bot
 * counts as both. A random pick never shows two hosts from the same company.
 */

export type WalkthroughHostCompany =
	| 'spacexai'
	| 'anthropic'
	| 'github'
	| 'opencode'
	| 'openai'
	| 'google'
	| 'sourcegraph'
	| 'warp'
	| 'block'
	| 'zed'
	| 'cognition'
	| 'pi'
	| 'openclaw'

export type WalkthroughHostSlot = 'coding' | 'invoke' | 'notify'

export type WalkthroughHostKind = 'coding' | 'chat' | 'both'

export type WalkthroughHost = {
	id: string
	label: string
	icon: string
	company: WalkthroughHostCompany
	kind: WalkthroughHostKind
}

/** Serializable triple embedded in SSR loader data so hydrate matches. */
export type WalkthroughHostPick = {
	coding: WalkthroughHost
	invoke: WalkthroughHost
	notify: WalkthroughHost
	/** All coding hosts, shuffled for the ask-act “Like …” row. */
	codingRow: Array<WalkthroughHost>
	/** All chat hosts, shuffled for the invoke-act “Like …” row. */
	chatRow: Array<WalkthroughHost>
	/** Every host, shuffled for the notify-act “Like …” row. */
	allRow: Array<WalkthroughHost>
}

export const walkthroughHostCatalog = [
	{
		id: 'cursor',
		label: 'Cursor',
		icon: 'cursor',
		company: 'spacexai',
		kind: 'coding',
	},
	{
		id: 'claude-code',
		label: 'Claude Code',
		icon: 'claudecode',
		company: 'anthropic',
		kind: 'coding',
	},
	{
		id: 'copilot',
		label: 'Copilot',
		icon: 'githubcopilot',
		company: 'github',
		kind: 'coding',
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		icon: 'opencode',
		company: 'opencode',
		kind: 'coding',
	},
	{
		id: 'codex',
		label: 'Codex',
		icon: 'codex',
		company: 'openai',
		kind: 'coding',
	},
	{
		id: 'chatgpt',
		label: 'ChatGPT',
		icon: 'chatgpt',
		company: 'openai',
		kind: 'chat',
	},
	{
		id: 'claude',
		label: 'Claude',
		icon: 'claude',
		company: 'anthropic',
		kind: 'chat',
	},
	{
		id: 'grok',
		label: 'Grok',
		icon: 'grok',
		company: 'spacexai',
		kind: 'chat',
	},
	{
		id: 'grok-bot',
		label: 'Grok Bot',
		icon: 'grokbot',
		company: 'spacexai',
		kind: 'both',
	},
	{
		id: 'gemini',
		label: 'Gemini',
		icon: 'gemini',
		company: 'google',
		kind: 'chat',
	},
	{
		id: 'amp',
		label: 'Amp',
		icon: 'amp',
		company: 'sourcegraph',
		kind: 'coding',
	},
	{
		id: 'warp',
		label: 'Warp',
		icon: 'warp',
		company: 'warp',
		kind: 'coding',
	},
	{
		id: 'goose',
		label: 'Goose',
		icon: 'goose',
		company: 'block',
		kind: 'coding',
	},
	{
		id: 'zed',
		label: 'Zed',
		icon: 'zed',
		company: 'zed',
		kind: 'coding',
	},
	{
		id: 'devin',
		label: 'Devin',
		icon: 'devin',
		company: 'cognition',
		kind: 'coding',
	},
	{
		id: 'pi',
		label: 'Pi',
		icon: 'pi',
		company: 'pi',
		kind: 'coding',
	},
	{
		id: 'openclaw',
		label: 'OpenClaw',
		icon: 'openclaw',
		company: 'openclaw',
		kind: 'coding',
	},
] as const satisfies ReadonlyArray<WalkthroughHost>

export type WalkthroughRandomInt = (maxExclusive: number) => number

export function randomWalkthroughInt(maxExclusive: number): number {
	if (maxExclusive <= 0) {
		throw new Error('randomWalkthroughInt requires a positive maximum')
	}
	const bytes = new Uint32Array(1)
	crypto.getRandomValues(bytes)
	return bytes[0]! % maxExclusive
}

export function walkthroughHostIsCoding(host: WalkthroughHost) {
	return host.kind === 'coding' || host.kind === 'both'
}

export function walkthroughHostIsChat(host: WalkthroughHost) {
	return host.kind === 'chat' || host.kind === 'both'
}

export function listCodingWalkthroughHosts(): Array<WalkthroughHost> {
	return walkthroughHostCatalog.filter(walkthroughHostIsCoding)
}

export function listChatWalkthroughHosts(): Array<WalkthroughHost> {
	return walkthroughHostCatalog.filter(walkthroughHostIsChat)
}

export function listAllWalkthroughHosts(): Array<WalkthroughHost> {
	return [...walkthroughHostCatalog]
}

export function shuffleWalkthroughHosts(
	hosts: ReadonlyArray<WalkthroughHost>,
	randomInt: WalkthroughRandomInt,
): Array<WalkthroughHost> {
	const next = [...hosts]
	for (let index = next.length - 1; index > 0; index--) {
		const span = index + 1
		const raw = randomInt(span)
		const swapAt = ((raw % span) + span) % span
		const current = next[index]
		const other = next[swapAt]
		if (!current || !other) continue
		next[index] = other
		next[swapAt] = current
	}
	return next
}

export function listValidWalkthroughHostPicks(): Array<
	Omit<WalkthroughHostPick, 'codingRow' | 'chatRow' | 'allRow'>
> {
	const codingHosts = listCodingWalkthroughHosts()
	const chatHosts = listChatWalkthroughHosts()
	const allHosts = listAllWalkthroughHosts()
	const picks: Array<
		Omit<WalkthroughHostPick, 'codingRow' | 'chatRow' | 'allRow'>
	> = []
	for (const coding of codingHosts) {
		for (const invoke of chatHosts) {
			if (invoke.id === coding.id) continue
			if (invoke.company === coding.company) continue
			for (const notify of allHosts) {
				if (notify.id === coding.id || notify.id === invoke.id) continue
				if (notify.company === coding.company) continue
				if (notify.company === invoke.company) continue
				picks.push({ coding, invoke, notify })
			}
		}
	}
	return picks
}

export function pickWalkthroughHosts(
	randomInt: WalkthroughRandomInt = randomWalkthroughInt,
): WalkthroughHostPick {
	const picks = listValidWalkthroughHostPicks()
	const pick = picks[randomInt(picks.length)]
	if (!pick) {
		throw new Error('No valid walkthrough host pick')
	}
	return {
		...pick,
		codingRow: shuffleWalkthroughHosts(listCodingWalkthroughHosts(), randomInt),
		chatRow: shuffleWalkthroughHosts(listChatWalkthroughHosts(), randomInt),
		allRow: shuffleWalkthroughHosts(listAllWalkthroughHosts(), randomInt),
	}
}

export function walkthroughHostById(id: string): WalkthroughHost | undefined {
	return walkthroughHostCatalog.find((host) => host.id === id)
}

export function walkthroughHostSlotForAct(
	actId: string,
): WalkthroughHostSlot | undefined {
	switch (actId) {
		case 'ask':
			return 'coding'
		case 'invoke':
			return 'invoke'
		case 'notify':
			return 'notify'
		default:
			return undefined
	}
}

export function walkthroughHostForAct(
	hosts: WalkthroughHostPick | null | undefined,
	actId: string,
): WalkthroughHost | undefined {
	if (!hosts) return undefined
	const slot = walkthroughHostSlotForAct(actId)
	if (!slot) return undefined
	return hosts[slot]
}

/** Fill `{coding}`, `{invoke}`, and `{notify}` in act kickers with host labels. */
export function resolveWalkthroughKicker(
	kicker: string,
	hosts?: WalkthroughHostPick | null,
): string {
	if (!hosts) return kicker
	return kicker
		.replaceAll('{coding}', hosts.coding.label)
		.replaceAll('{invoke}', hosts.invoke.label)
		.replaceAll('{notify}', hosts.notify.label)
}

export function walkthroughHostSlotLabel(slot: WalkthroughHostSlot) {
	switch (slot) {
		case 'coding':
			return 'Regular coding agent'
		case 'invoke':
			return 'Chat agent on your phone'
		case 'notify':
			return 'Another agent you sometimes use'
		default: {
			const exhaustive: never = slot
			return exhaustive
		}
	}
}

function walkthroughHostFitsSlot(
	host: WalkthroughHost,
	slot: WalkthroughHostSlot,
) {
	switch (slot) {
		case 'coding':
			return walkthroughHostIsCoding(host)
		case 'invoke':
			return walkthroughHostIsChat(host)
		case 'notify':
			return true
		default: {
			const exhaustive: never = slot
			return exhaustive
		}
	}
}

function walkthroughHostsForSlot(slot: WalkthroughHostSlot) {
	switch (slot) {
		case 'coding':
			return listCodingWalkthroughHosts()
		case 'invoke':
			return listChatWalkthroughHosts()
		case 'notify':
			return listAllWalkthroughHosts()
		default: {
			const exhaustive: never = slot
			return exhaustive
		}
	}
}

function otherWalkthroughHostIds(
	pick: WalkthroughHostPick,
	slot: WalkthroughHostSlot,
) {
	const ids = new Set<string>()
	if (slot !== 'coding') ids.add(pick.coding.id)
	if (slot !== 'invoke') ids.add(pick.invoke.id)
	if (slot !== 'notify') ids.add(pick.notify.id)
	return ids
}

/** Hosts that can fill one story slot without duplicating the other two. */
export function listWalkthroughHostOptions(
	pick: WalkthroughHostPick,
	slot: WalkthroughHostSlot,
): Array<WalkthroughHost> {
	const taken = otherWalkthroughHostIds(pick, slot)
	return walkthroughHostsForSlot(slot)
		.filter((host) => !taken.has(host.id))
		.sort((left, right) => left.label.localeCompare(right.label))
}

export function replaceWalkthroughHost(
	pick: WalkthroughHostPick,
	slot: WalkthroughHostSlot,
	hostId: string,
): WalkthroughHostPick {
	const host = walkthroughHostById(hostId)
	if (!host) return pick
	if (!walkthroughHostFitsSlot(host, slot)) return pick
	if (otherWalkthroughHostIds(pick, slot).has(host.id)) return pick
	if (pick[slot].id === host.id) return pick
	return { ...pick, [slot]: host }
}

export function walkthroughHostMarkUrl(host: WalkthroughHost) {
	return `/images/icons/${host.icon}.svg`
}

/** Conversation hosts in story order, unique by id. */
export function listWalkthroughConversationHosts(
	hosts: WalkthroughHostPick,
): Array<WalkthroughHost> {
	const seen = new Set<string>()
	const unique: Array<WalkthroughHost> = []
	for (const host of [hosts.coding, hosts.invoke, hosts.notify]) {
		if (seen.has(host.id)) continue
		seen.add(host.id)
		unique.push(host)
	}
	return unique
}

export function joinWalkthroughHostLabels(
	labels: ReadonlyArray<string>,
): string {
	if (labels.length === 0) return ''
	if (labels.length === 1) return labels[0]!
	if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
	return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
}

export function isValidWalkthroughHostPick(
	value: WalkthroughHostPick,
): boolean {
	if (!walkthroughHostIsCoding(value.coding)) return false
	if (!walkthroughHostIsChat(value.invoke)) return false
	if (value.invoke.id === value.coding.id) return false
	if (value.notify.id === value.coding.id) return false
	if (value.notify.id === value.invoke.id) return false
	const companies = new Set([
		value.coding.company,
		value.invoke.company,
		value.notify.company,
	])
	if (companies.size !== 3) return false
	const codingIds = new Set(listCodingWalkthroughHosts().map((host) => host.id))
	const chatIds = new Set(listChatWalkthroughHosts().map((host) => host.id))
	if (value.codingRow.length !== codingIds.size) return false
	if (new Set(value.codingRow.map((host) => host.id)).size !== codingIds.size) {
		return false
	}
	if (
		!value.codingRow.every(
			(host) => walkthroughHostIsCoding(host) && codingIds.has(host.id),
		)
	) {
		return false
	}
	if (value.chatRow.length !== chatIds.size) return false
	if (new Set(value.chatRow.map((host) => host.id)).size !== chatIds.size) {
		return false
	}
	if (
		!value.chatRow.every(
			(host) => walkthroughHostIsChat(host) && chatIds.has(host.id),
		)
	) {
		return false
	}
	const allIds = new Set(listAllWalkthroughHosts().map((host) => host.id))
	if (value.allRow.length !== allIds.size) return false
	if (new Set(value.allRow.map((host) => host.id)).size !== allIds.size) {
		return false
	}
	return value.allRow.every((host) => allIds.has(host.id))
}

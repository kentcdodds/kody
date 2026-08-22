#!/usr/bin/env node
/**
 * Memory auto-surface policy lab.
 *
 * Deterministic simulation: same memories, same traces, many policies.
 * Measures visibility at decision points, isolation across agents, and
 * token cost. Does not claim an LLM would obey the memory — only whether
 * the distinctive text was in the model-visible window.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir =
	process.env.LAB_OUT_DIR ?? join(here, '../../.tmp/memory-auto-surface-lab')

const memories = [
	{
		id: 'd6c5aea4-5f7c-4474-8ec9-0af08f3973c8',
		subject: 'Email: draft only, never send',
		summary:
			'Never send email unless Kent explicitly asks to send that specific message. "Draft" means create a Gmail draft.',
		details:
			'Kent has been burned by agents sending mail after he said draft. Draft is the Gmail draft primitive, not a polite synonym for send. Sending requires an explicit send of that exact message. Do not send follow-up repair mail. Do not interpret "looks good" as permission to send. If unsure, leave a draft and ask.',
		category: 'preference',
		status: 'active',
		tags: ['email', 'gmail', 'draft'],
		sourceUris: ['https://mail.google.com/'],
		updatedAt: '2026-08-21T18:00:00.000Z',
	},
	{
		id: 'voice-kent-writing',
		subject: 'Writing voice',
		summary: 'Write like Kent: direct, present tense, no corporate filler.',
		details:
			'Prefer short sentences. Avoid "leverage", "utilize", and changelog voice. Present tense. Name the thing. Do not open with a negation.',
		category: 'preference',
		status: 'active',
		tags: ['voice', 'writing'],
		sourceUris: [],
		updatedAt: '2026-08-10T00:00:00.000Z',
	},
	{
		id: 'email-habits-weak-subject',
		subject: 'Email habits',
		summary:
			'Never send email unless Kent explicitly asks to send that specific message. Draft only means Gmail draft.',
		details:
			'Same rule as the titled memory, but the subject does not carry the constraint.',
		category: 'preference',
		status: 'active',
		tags: ['email'],
		sourceUris: [],
		updatedAt: '2026-08-21T18:00:00.000Z',
	},
	{
		id: 'kody-bot-favorite',
		subject: 'Favorite bot',
		summary:
			"kody-bot is my favorite bot. I'm really interested in what it ships on github",
		details:
			'Watch public GitHub events for kody-bot releases and new public repos.',
		category: 'profile',
		status: 'active',
		tags: ['github', 'kody-bot'],
		sourceUris: ['https://github.com/kody-bot'],
		updatedAt: '2026-07-01T00:00:00.000Z',
	},
]

const criticalPhrases = [/never send/i, /draft only/i]
const verbTrigger = /\b(send|email|draft|mail|gmail)\b/i

const searchWhenValues = ['never', 'query', 'memoryContext']
const executeWhenValues = ['never', 'memoryContext', 'always']
const payloadValues = [
	'none',
	'id',
	'subject',
	'subject_summary',
	'subject_summary_category',
	'full',
	'search_full_execute_summary',
	'search_summary_execute_none',
	'stub_after_first',
	'budget_200',
	'keywords',
	'summary_80',
]
const suppressValues = [
	'none',
	'echoed_handle',
	'any_resolved_handle',
	'after_first_search_on_handle',
	'query_hash_on_handle',
	'user_global',
]
const repeatFormValues = ['omit', 'count_line', 'ids_only', 'still_in_effect']
const maxMemoryValues = [1, 2]

function estimateTokens(text) {
	if (!text) return 0
	return Math.ceil(text.length / 4)
}

function keywordsFrom(memory) {
	const words = `${memory.subject} ${memory.summary}`
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 3)
	return [...new Set(words)].slice(0, 8).join(' ')
}

function renderPayload(policy, tool, selected, alreadyShown) {
	const mode = resolvePayloadMode(policy, tool, alreadyShown)
	if (mode === 'none' || selected.length === 0) {
		return { markdown: '', structured: '', visibleText: '', ids: [] }
	}
	if (
		mode === 'stub' ||
		mode === 'still_in_effect' ||
		mode === 'stub_summary'
	) {
		const markdown =
			mode === 'stub_summary'
				? selected
						.map((memory) => `- ${memory.subject} — ${memory.summary}`)
						.join('\n')
				: `Memories still in effect: ${selected.map((memory) => memory.subject).join('; ')}.`
		return {
			markdown,
			structured: JSON.stringify({ ids: selected.map((memory) => memory.id) }),
			visibleText: markdown,
			ids: selected.map((memory) => memory.id),
		}
	}
	if (mode === 'ids_only' || mode === 'id') {
		const markdown =
			mode === 'ids_only'
				? selected.map((memory) => memory.id).join(', ')
				: selected.map((memory) => `- ${memory.id}`).join('\n')
		const structured = JSON.stringify({
			surfaced: selected.map((memory) => ({ id: memory.id })),
		})
		return {
			markdown,
			structured,
			visibleText: markdown,
			ids: selected.map((memory) => memory.id),
		}
	}

	const lines = ['## Relevant memories', '']
	const structuredItems = []
	let budgetLeft = mode === 'budget_200' ? 200 : Infinity
	for (const memory of selected) {
		let line
		const item = { id: memory.id }
		switch (mode) {
			case 'subject':
				line = `- **${memory.subject}**`
				item.subject = memory.subject
				break
			case 'subject_summary_category':
				line = `- **${memory.subject}** — ${memory.summary} (${memory.category})`
				item.subject = memory.subject
				item.summary = memory.summary
				item.category = memory.category
				break
			case 'full':
				line = [
					`- **${memory.subject}** — ${memory.summary}`,
					`  - Category: \`${memory.category}\``,
					`  - Tags: ${memory.tags.map((tag) => `\`${tag}\``).join(', ')}`,
					`  - Sources: ${memory.sourceUris.map((uri) => `\`${uri}\``).join(', ')}`,
					`  - Updated: \`${memory.updatedAt}\``,
					`  - Details: ${memory.details}`,
				].join('\n')
				Object.assign(item, {
					subject: memory.subject,
					summary: memory.summary,
					details: memory.details,
					category: memory.category,
					status: memory.status,
					tags: memory.tags,
					sourceUris: memory.sourceUris,
					updatedAt: memory.updatedAt,
				})
				break
			case 'keywords':
				line = `- ${keywordsFrom(memory)}`
				item.keywords = keywordsFrom(memory)
				break
			case 'summary_80':
				line = `- **${memory.subject}** — ${memory.summary.slice(0, 80)}`
				item.subject = memory.subject
				item.summary = memory.summary.slice(0, 80)
				break
			default:
				line = `- **${memory.subject}** — ${memory.summary}`
				item.subject = memory.subject
				item.summary = memory.summary
		}
		if (mode === 'budget_200') {
			const next = [...lines, line].join('\n')
			if (next.length > budgetLeft + '## Relevant memories\n\n'.length) break
		}
		lines.push(line)
		structuredItems.push(item)
	}
	const markdown = lines.join('\n')
	const structured = JSON.stringify({ surfaced: structuredItems })
	return {
		markdown,
		structured,
		visibleText: markdown,
		ids: structuredItems.map((item) => item.id),
	}
}

function resolvePayloadMode(policy, tool, alreadyShown) {
	if (policy.payload === 'none') return 'none'
	if (policy.payload === 'search_full_execute_summary') {
		return tool === 'search' ? 'full' : 'subject_summary'
	}
	if (policy.payload === 'search_summary_execute_none') {
		return tool === 'search' ? 'subject_summary' : 'none'
	}
	if (policy.payload === 'stub_after_first') {
		return alreadyShown ? 'stub' : 'subject_summary'
	}
	if (policy.payload === 'stub_summary') {
		return alreadyShown ? 'stub_summary' : 'subject_summary'
	}
	if (policy.repeatForm === 'still_in_effect' && alreadyShown)
		return 'still_in_effect'
	if (policy.repeatForm === 'ids_only' && alreadyShown) return 'ids_only'
	if (policy.repeatForm === 'count_line' && alreadyShown) return 'count'
	return policy.payload
}

function shouldRetrieve(policy, call) {
	const when = call.tool === 'search' ? policy.searchWhen : policy.executeWhen
	if (when === 'never') return false
	if (when === 'always') return true
	if (when === 'memoryContext') return Boolean(call.memoryContext)
	if (when === 'query') {
		if (call.tool === 'search') return Boolean(call.query)
		return Boolean(call.memoryContext || call.query)
	}
	if (when === 'verb_trigger') {
		const hay = `${call.query ?? ''} ${call.domain ?? ''}`
		return verbTrigger.test(hay) || Boolean(call.memoryContext)
	}
	if (when === 'only_if_no_prior_search') {
		return call.tool === 'execute' && !call.priorSearchOnHandle
	}
	return false
}

function selectMemories(policy, call) {
	const query = `${call.query ?? ''} ${call.domain ?? ''}`.toLowerCase()
	if (call.weakSubject) {
		const weak = memories.find(
			(memory) => memory.id === 'email-habits-weak-subject',
		)
		return [weak, memories[1]].slice(0, policy.maxMemories)
	}
	if (call.criticalIsRankTwo) {
		return [memories[1], memories[0], memories[3]].slice(0, policy.maxMemories)
	}
	const ranked =
		query.includes('bot') || query.includes('github')
			? [memories[3], memories[0], memories[1]]
			: [memories[0], memories[1], memories[3]]
	return ranked.slice(0, policy.maxMemories)
}

function suppressionKey(policy, call, resolvedId) {
	switch (policy.suppress) {
		case 'none':
			return null
		case 'user_global':
			return 'user-recent'
		case 'echoed_handle':
			return call.conversationId === 'echo' || call.conversationId === 'reuse'
				? resolvedId
				: null
		case 'any_resolved_handle':
			return resolvedId
		case 'after_first_search_on_handle':
			return resolvedId
		case 'query_hash_on_handle':
			return `${resolvedId}:${(call.query ?? '').trim().toLowerCase()}`
		default:
			return resolvedId
	}
}

const baselineScenarios = [
	{
		id: 'email-incident',
		name: 'Search email then execute send; omit conversationId and memoryContext',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: false,
				conversationId: 'omit',
			},
			{
				tool: 'execute',
				query: 'send the draft',
				memoryContext: false,
				conversationId: 'omit',
			},
		],
		decisionCallIndex: 1,
	},
	{
		id: 'email-incident-memoryContext',
		name: 'Same send path but execute passes memoryContext',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: true,
				conversationId: 'omit',
			},
			{
				tool: 'execute',
				query: 'send the draft',
				memoryContext: true,
				conversationId: 'omit',
			},
		],
		decisionCallIndex: 1,
	},
	{
		id: 'well-behaved',
		name: 'Search plus four executes; echo conversationId and memoryContext',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: true,
				conversationId: 'omit',
			},
			...Array.from({ length: 4 }, () => ({
				tool: 'execute',
				query: 'continue email work',
				memoryContext: true,
				conversationId: 'echo',
			})),
		],
		decisionCallIndex: 1,
	},
	{
		id: 'execute-loop-no-id',
		name: 'Eight executes with memoryContext and a fresh omit each time',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: Array.from({ length: 8 }, () => ({
			tool: 'execute',
			query: 'email draft work',
			memoryContext: true,
			conversationId: 'omit',
		})),
		decisionCallIndex: 0,
	},
	{
		id: 'execute-only-send',
		name: 'Execute-only send, memoryContext present, no prior search',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'execute',
				query: 'send this email',
				memoryContext: true,
				conversationId: 'omit',
			},
		],
		decisionCallIndex: 0,
	},
	{
		id: 'execute-only-no-context',
		name: 'Execute-only send, no memoryContext (stretch)',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		stretch: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'execute',
				query: 'send this email',
				memoryContext: false,
				conversationId: 'omit',
			},
		],
		decisionCallIndex: 0,
	},
	{
		id: 'compaction-weak-subject',
		name: 'Weak subject plus compaction after echoed executes',
		host: 'markdown_only',
		windowSize: 3,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: true,
				conversationId: 'omit',
				weakSubject: true,
			},
			...Array.from({ length: 6 }, () => ({
				tool: 'execute',
				query: 'more email work',
				memoryContext: true,
				conversationId: 'echo',
				weakSubject: true,
			})),
		],
		decisionCallIndex: 6,
	},
	{
		id: 'compaction-3',
		name: 'Search then six executes; only last 3 tool results stay in context',
		host: 'markdown_only',
		windowSize: 3,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: true,
				conversationId: 'omit',
			},
			...Array.from({ length: 6 }, () => ({
				tool: 'execute',
				query: 'more email work',
				memoryContext: true,
				conversationId: 'echo',
			})),
		],
		decisionCallIndex: 6,
	},
	{
		id: 'empty-browse',
		name: 'Empty search should not dump memories',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: false,
		isolationPeer: false,
		calls: [{ tool: 'search', memoryContext: false, conversationId: 'omit' }],
		decisionCallIndex: 0,
	},
	{
		id: 'weak-subject',
		name: 'Subject is generic; the rule lives in the summary',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: false,
				conversationId: 'omit',
				weakSubject: true,
			},
			{
				tool: 'execute',
				query: 'send the draft',
				memoryContext: false,
				conversationId: 'omit',
				weakSubject: true,
			},
		],
		decisionCallIndex: 1,
	},
	{
		id: 'critical-is-rank-two',
		name: 'Critical email rule is rank 2 behind a writing-voice memory',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: false,
				conversationId: 'omit',
				criticalIsRankTwo: true,
			},
			{
				tool: 'execute',
				query: 'send the draft',
				memoryContext: false,
				conversationId: 'omit',
				criticalIsRankTwo: true,
			},
		],
		decisionCallIndex: 1,
	},
	{
		id: 'domain-email-search',
		name: 'Domain-scoped email search is the decision',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: false,
				conversationId: 'omit',
			},
		],
		decisionCallIndex: 0,
	},
	{
		id: 'task-change',
		name: 'Email then unrelated github; decision is a later email execute',
		host: 'markdown_only',
		windowSize: 4,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: true,
				conversationId: 'omit',
			},
			{
				tool: 'search',
				query: 'favorite bot github',
				memoryContext: true,
				conversationId: 'echo',
			},
			{
				tool: 'execute',
				query: 'list github events',
				memoryContext: true,
				conversationId: 'echo',
			},
			{
				tool: 'execute',
				query: 'send the draft now',
				memoryContext: true,
				conversationId: 'echo',
			},
		],
		decisionCallIndex: 3,
	},
	{
		id: 'structured-host',
		name: 'Host forwards structured content as well as markdown',
		host: 'both',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: false,
				conversationId: 'omit',
			},
			{
				tool: 'execute',
				query: 'send',
				memoryContext: false,
				conversationId: 'echo',
			},
		],
		decisionCallIndex: 1,
	},
	{
		id: 'fresh-ids-every-call',
		name: 'Caller invents a new conversationId each call',
		host: 'markdown_only',
		windowSize: 999,
		expectVisible: true,
		isolationPeer: true,
		calls: [
			{
				tool: 'search',
				query: 'send a message',
				domain: 'email',
				memoryContext: true,
				conversationId: 'fresh',
			},
			{
				tool: 'execute',
				query: 'send',
				memoryContext: true,
				conversationId: 'fresh',
			},
			{
				tool: 'execute',
				query: 'send again',
				memoryContext: true,
				conversationId: 'fresh',
			},
		],
		decisionCallIndex: 1,
	},
]

function textHasCritical(text) {
	return criticalPhrases.some((pattern) => pattern.test(text))
}

function simulate(policy, scenario, inherited = null) {
	let mintCounter = inherited?.mintCounter ?? 0
	let echoedId = null
	const shownByKey = inherited?.shownByKey ?? new Map()
	const userGlobal = inherited?.userGlobal ?? new Set()
	const searchSeenByHandle = inherited?.searchSeenByHandle ?? new Set()
	const results = []

	for (const [index, call] of scenario.calls.entries()) {
		let resolvedId
		if (call.conversationId === 'echo' && echoedId) {
			resolvedId = echoedId
		} else if (call.conversationId === 'reuse' && echoedId) {
			resolvedId = echoedId
		} else {
			resolvedId = `mint-${++mintCounter}`
			if (call.conversationId !== 'fresh') echoedId = resolvedId
			if (call.conversationId === 'fresh') echoedId = resolvedId
		}

		const priorSearchOnHandle = searchSeenByHandle.has(resolvedId)
		const callWithPrior = { ...call, priorSearchOnHandle }
		const retrieve = shouldRetrieve(policy, callWithPrior)
		const selected = retrieve ? selectMemories(policy, call) : []

		const key = suppressionKey(policy, call, resolvedId)
		const shown = new Set([
			...(key ? (shownByKey.get(key) ?? []) : []),
			...userGlobal,
		])
		const alreadyShown = selected.some((memory) => shown.has(memory.id))
		const visibleSelected =
			policy.suppress === 'none'
				? selected
				: selected.filter((memory) => !shown.has(memory.id))

		let rendered
		if (
			alreadyShown &&
			visibleSelected.length === 0 &&
			policy.repeatForm === 'count_line' &&
			selected.length > 0
		) {
			const markdown = `Suppressed ${selected.length} memories surfaced earlier in this conversation.`
			rendered = {
				markdown,
				structured: '',
				visibleText: markdown,
				ids: [],
			}
		} else if (policy.payload === 'stub_after_first' && alreadyShown) {
			rendered = renderPayload(policy, call.tool, selected, true)
		} else {
			rendered = renderPayload(policy, call.tool, visibleSelected, alreadyShown)
		}

		if (call.tool === 'search' && retrieve) searchSeenByHandle.add(resolvedId)

		if (
			policy.suppress === 'after_first_search_on_handle' &&
			call.tool === 'search' &&
			rendered.ids.length > 0 &&
			key
		) {
			const next = shownByKey.get(key) ?? new Set()
			for (const id of rendered.ids) next.add(id)
			shownByKey.set(key, next)
		} else if (rendered.ids.length > 0 && key) {
			const next = shownByKey.get(key) ?? new Set()
			for (const id of rendered.ids) next.add(id)
			shownByKey.set(key, next)
		}
		if (policy.suppress === 'user_global') {
			for (const id of rendered.ids) userGlobal.add(id)
		}

		const hostVisible =
			scenario.host === 'both'
				? `${rendered.visibleText}\n${rendered.structured}`
				: rendered.visibleText

		results.push({
			index,
			tool: call.tool,
			resolvedId,
			retrieve,
			ids: rendered.ids,
			markdown: rendered.markdown,
			structured: rendered.structured,
			hostVisible,
			tokens:
				estimateTokens(rendered.markdown) + estimateTokens(rendered.structured),
			criticalHere: textHasCritical(hostVisible),
		})
	}

	const windowSize = scenario.windowSize ?? 999
	const decision = results[scenario.decisionCallIndex]
	const windowStart = Math.max(0, scenario.decisionCallIndex - windowSize + 1)
	const inWindow = results.slice(windowStart, scenario.decisionCallIndex + 1)
	const windowText = inWindow.map((result) => result.hostVisible).join('\n')
	const reliability = textHasCritical(windowText) ? 1 : 0
	const tokens = results.reduce((sum, result) => sum + result.tokens, 0)
	const waste = results.slice(1).reduce((sum, result, offset) => {
		const prior = results.slice(0, offset + 1)
		const priorText = prior.map((item) => item.hostVisible).join('\n')
		if (textHasCritical(priorText) && textHasCritical(result.hostVisible)) {
			return sum + result.tokens
		}
		return sum
	}, 0)

	let isolation = 1
	if (scenario.isolationPeer) {
		const peer = simulate(
			policy,
			{
				id: `${scenario.id}-peer`,
				name: 'peer',
				host: scenario.host,
				windowSize: 999,
				expectVisible: true,
				isolationPeer: false,
				calls: [
					{
						tool: 'search',
						query: scenario.calls[0]?.query ?? 'send a message',
						domain: scenario.calls[0]?.domain ?? 'email',
						memoryContext: false,
						conversationId: 'fresh',
						weakSubject: scenario.calls[0]?.weakSubject,
					},
				],
				decisionCallIndex: 0,
			},
			{
				mintCounter,
				shownByKey,
				userGlobal,
				searchSeenByHandle,
			},
		)
		isolation = peer.reliability
	}

	const unexpectedShow =
		scenario.expectVisible === false && reliability === 1 ? 1 : 0

	return {
		reliability,
		tokens,
		waste,
		isolation,
		unexpectedShow,
		decisionCritical: decision?.criticalHere ?? 0,
		calls: results.length,
		windowText,
	}
}

function cartesianPolicies() {
	const policies = []
	for (const searchWhen of searchWhenValues) {
		for (const executeWhen of executeWhenValues) {
			for (const payload of payloadValues) {
				for (const suppress of suppressValues) {
					for (const repeatForm of repeatFormValues) {
						for (const maxMemories of maxMemoryValues) {
							if (
								payload === 'none' &&
								(searchWhen !== 'never' || executeWhen !== 'never')
							) {
								continue
							}
							if (
								searchWhen === 'never' &&
								executeWhen === 'never' &&
								payload !== 'none'
							) {
								continue
							}
							policies.push({
								id: [
									searchWhen,
									executeWhen,
									payload,
									suppress,
									repeatForm,
									`n${maxMemories}`,
								].join('/'),
								searchWhen,
								executeWhen,
								payload,
								suppress,
								repeatForm,
								maxMemories,
								family: 'grid',
							})
						}
					}
				}
			}
		}
	}
	return policies
}

function verbAndAsymmetryPolicies() {
	const policies = []
	for (const searchWhen of ['query', 'verb_trigger', 'memoryContext']) {
		for (const executeWhen of [
			'never',
			'memoryContext',
			'verb_trigger',
			'only_if_no_prior_search',
		]) {
			for (const payload of [
				'subject',
				'subject_summary',
				'search_full_execute_summary',
				'search_summary_execute_none',
				'stub_after_first',
				'keywords',
				'summary_80',
			]) {
				for (const suppress of [
					'none',
					'any_resolved_handle',
					'echoed_handle',
					'after_first_search_on_handle',
					'query_hash_on_handle',
				]) {
					for (const maxMemories of [1, 2]) {
						policies.push({
							id: [
								'xtra',
								searchWhen,
								executeWhen,
								payload,
								suppress,
								`n${maxMemories}`,
							].join('/'),
							searchWhen,
							executeWhen,
							payload,
							suppress,
							repeatForm: 'omit',
							maxMemories,
							family: 'asymmetric',
						})
					}
				}
			}
		}
	}
	return policies
}

function namedBaselines() {
	return [
		{
			id: 'current-main-full-any-handle',
			family: 'named',
			searchWhen: 'query',
			executeWhen: 'memoryContext',
			payload: 'full',
			suppress: 'any_resolved_handle',
			repeatForm: 'omit',
			maxMemories: 2,
		},
		{
			id: 'user-recent-4h',
			family: 'named',
			searchWhen: 'query',
			executeWhen: 'memoryContext',
			payload: 'subject_summary',
			suppress: 'user_global',
			repeatForm: 'omit',
			maxMemories: 2,
		},
		{
			id: 'recommended-compact-echo',
			family: 'named',
			searchWhen: 'query',
			executeWhen: 'memoryContext',
			payload: 'subject_summary',
			suppress: 'any_resolved_handle',
			repeatForm: 'omit',
			maxMemories: 2,
		},
		{
			id: 'search-only-compact',
			family: 'named',
			searchWhen: 'query',
			executeWhen: 'never',
			payload: 'subject_summary',
			suppress: 'any_resolved_handle',
			repeatForm: 'omit',
			maxMemories: 2,
		},
		{
			id: 'always-full-no-suppress',
			family: 'named',
			searchWhen: 'query',
			executeWhen: 'always',
			payload: 'full',
			suppress: 'none',
			repeatForm: 'omit',
			maxMemories: 2,
		},
		{
			id: 'search-full-execute-none',
			family: 'named',
			searchWhen: 'query',
			executeWhen: 'never',
			payload: 'search_summary_execute_none',
			suppress: 'any_resolved_handle',
			repeatForm: 'omit',
			maxMemories: 1,
		},
		{
			id: 'verb-trigger-subject',
			family: 'named',
			searchWhen: 'verb_trigger',
			executeWhen: 'verb_trigger',
			payload: 'subject',
			suppress: 'any_resolved_handle',
			repeatForm: 'omit',
			maxMemories: 1,
		},
	]
}

async function loadExtras() {
	const { readFileSync, existsSync } = await import('node:fs')
	const extras = []
	for (const name of ['extra-policies.json', 'agent-policies.json']) {
		const path = join(here, name)
		if (!existsSync(path)) continue
		const parsed = JSON.parse(readFileSync(path, 'utf8'))
		const list = Array.isArray(parsed) ? parsed : parsed.policies
		for (const policy of list ?? []) extras.push({ ...policy, family: 'agent' })
	}
	return extras
}

async function loadExtraScenarios() {
	const { readFileSync, existsSync } = await import('node:fs')
	const path = join(here, 'extra-scenarios.json')
	if (!existsSync(path)) return []
	const parsed = JSON.parse(readFileSync(path, 'utf8'))
	return Array.isArray(parsed) ? parsed : []
}

function scorePolicy(policy, scenarios) {
	const perScenario = {}
	let reliabilityHits = 0
	let reliabilityNeed = 0
	let coreHits = 0
	let coreNeed = 0
	let stretchHits = 0
	let stretchNeed = 0
	let isolationHits = 0
	let isolationNeed = 0
	let unexpected = 0
	let tokens = 0
	let waste = 0
	let compactionReliability = 0
	let compactionNeed = 0
	let incidentReliability = 0

	for (const scenario of scenarios) {
		const result = simulate(policy, scenario)
		perScenario[scenario.id] = result
		if (scenario.expectVisible) {
			reliabilityNeed += 1
			reliabilityHits += result.reliability
			if (scenario.stretch) {
				stretchNeed += 1
				stretchHits += result.reliability
			} else {
				coreNeed += 1
				coreHits += result.reliability
			}
			if (scenario.id === 'email-incident')
				incidentReliability = result.reliability
			if (scenario.id.startsWith('compaction')) {
				compactionNeed += 1
				compactionReliability += result.reliability
			}
		}
		if (scenario.isolationPeer) {
			isolationNeed += 1
			isolationHits += result.isolation
		}
		unexpected += result.unexpectedShow
		tokens += result.tokens
		waste += result.waste
	}

	const reliability =
		reliabilityNeed === 0 ? 0 : reliabilityHits / reliabilityNeed
	const coreReliability = coreNeed === 0 ? 0 : coreHits / coreNeed
	const stretchReliability = stretchNeed === 0 ? 0 : stretchHits / stretchNeed
	const isolation = isolationNeed === 0 ? 1 : isolationHits / isolationNeed
	const compaction =
		compactionNeed === 0 ? 1 : compactionReliability / compactionNeed
	const hardFail = isolation < 1 || unexpected > 0
	const requiredMiss = coreReliability < 1
	const composite =
		(hardFail ? -1000 : 0) +
		coreReliability * 100 +
		incidentReliability * 25 +
		compaction * 15 +
		stretchReliability * 5 -
		tokens / 200 -
		waste / 400 -
		unexpected * 15

	return {
		policyId: policy.id,
		family: policy.family,
		reliability,
		coreReliability,
		stretchReliability,
		isolation,
		compaction,
		incidentReliability,
		unexpected,
		tokens,
		waste,
		hardFail,
		requiredMiss,
		composite: Number(composite.toFixed(3)),
		perScenario,
		policy,
	}
}

function summarize(rows) {
	const feasible = rows.filter((row) => !row.hardFail)
	const perfect = feasible.filter((row) => !row.requiredMiss)
	const byReliability = [...rows].sort((a, b) => {
		if (a.hardFail !== b.hardFail) return a.hardFail ? 1 : -1
		if (b.coreReliability !== a.coreReliability) {
			return b.coreReliability - a.coreReliability
		}
		if (b.reliability !== a.reliability) return b.reliability - a.reliability
		if (b.incidentReliability !== a.incidentReliability) {
			return b.incidentReliability - a.incidentReliability
		}
		if (a.tokens !== b.tokens) return a.tokens - b.tokens
		return a.waste - b.waste
	})
	const byComposite = [...rows].sort((a, b) => b.composite - a.composite)
	const pareto = []
	for (const row of [...perfect].sort((a, b) => a.tokens - b.tokens)) {
		if (pareto.length === 0 || row.waste <= pareto[pareto.length - 1].waste) {
			pareto.push(row)
		}
	}
	return {
		total: rows.length,
		feasible: feasible.length,
		perfect: perfect.length,
		hardFailed: rows.length - feasible.length,
		bestComposite: byComposite[0],
		bestPerfectCheapest: perfect.sort(
			(a, b) => a.tokens - b.tokens || a.waste - b.waste,
		)[0],
		bestFeasible: byReliability[0],
		pareto: pareto.slice(0, 12).map(slimRow),
		topComposite: byComposite.slice(0, 15).map(slimRow),
		named: rows.filter((row) => row.family === 'named').map(slimRow),
	}
}

function leaveOneOutWinners(policies, scenarios) {
	const core = scenarios.filter((scenario) => !scenario.stretch)
	const out = []
	for (const dropped of core) {
		const subset = scenarios.filter((scenario) => scenario.id !== dropped.id)
		let best = null
		for (const policy of policies) {
			const row = scorePolicy(policy, subset)
			if (!best || row.composite > best.composite)
				best = { ...slimRow(row), dropped: dropped.id }
		}
		out.push(best)
	}
	return out
}

function clusterWinners(perfectRows) {
	const groups = new Map()
	for (const row of perfectRows) {
		const key = [
			row.policy.searchWhen,
			row.policy.executeWhen,
			row.policy.payload,
			row.policy.suppress,
			row.policy.maxMemories,
		].join('|')
		const current = groups.get(key)
		if (!current || row.tokens < current.tokens) {
			groups.set(key, slimRow(row))
		}
	}
	return [...groups.values()].sort((a, b) => a.tokens - b.tokens).slice(0, 25)
}

function slimRow(row) {
	return {
		id: row.policyId,
		family: row.family,
		composite: row.composite,
		reliability: Number(row.reliability.toFixed(3)),
		core: Number(row.coreReliability.toFixed(3)),
		stretch: Number(row.stretchReliability.toFixed(3)),
		isolation: Number(row.isolation.toFixed(3)),
		compaction: Number(row.compaction.toFixed(3)),
		incident: row.incidentReliability,
		unexpected: row.unexpected,
		tokens: row.tokens,
		waste: row.waste,
		hardFail: row.hardFail,
		searchWhen: row.policy.searchWhen,
		executeWhen: row.policy.executeWhen,
		payload: row.policy.payload,
		suppress: row.policy.suppress,
		repeatForm: row.policy.repeatForm,
		maxMemories: row.policy.maxMemories,
	}
}

function markdownReport(summary, scenarios) {
	const winner = summary.bestComposite
	const cheap = summary.bestPerfectCheapest
	const lines = [
		'# Memory auto-surface lab',
		'',
		`Tried **${summary.total}** policies on **${scenarios.length}** traces.`,
		`${summary.feasible} keep concurrent-agent isolation.`,
		`${summary.perfect} also hit every **core** required-visibility scene.`,
		'Execute-only send with no memoryContext is stretch, not core.',
		`${summary.hardFailed} fail isolation or dump memories on empty browse.`,
		'',
		'This is a deterministic window simulation, not an LLM eval. It answers:',
		'was the distinctive text in the model-visible tool window at the decision,',
		'and what did that cost in tokens (chars/4).',
		'',
		'## Winner by composite',
		'',
		winner ? formatWinner(winner) : '_none_',
		'',
		'## Cheapest perfect (isolation + all required scenes)',
		'',
		cheap
			? formatWinner(cheap)
			: '_none — no policy hit every required scene without breaking isolation_',
		'',
		'## Named baselines',
		'',
		'| id | rel | incident | compact | tokens | waste | fail |',
		'| --- | --- | --- | --- | --- | --- | --- |',
		...summary.named.map(
			(row) =>
				`| ${row.id} | ${row.reliability} | ${row.incident} | ${row.compaction} | ${row.tokens} | ${row.waste} | ${row.hardFail} |`,
		),
		'',
		'## Top composite',
		'',
		'| id | rel | tokens | waste | payload | search | execute | suppress | n |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
		...summary.topComposite.map(
			(row) =>
				`| ${row.id} | ${row.reliability} | ${row.tokens} | ${row.waste} | ${row.payload} | ${row.searchWhen} | ${row.executeWhen} | ${row.suppress} | ${row.maxMemories} |`,
		),
		'',
		'## Pareto cheap-among-perfect',
		'',
		...summary.pareto.map(
			(row) => `- \`${row.id}\` tokens=${row.tokens} waste=${row.waste}`,
		),
		'',
		'## Product slice',
		'',
		'Core-perfect, not user-global, not execute-always, payload in',
		'`subject_summary` / `summary_80` / `stub_after_first`.',
		'',
		'| id | tokens | waste | suppress | execute | n |',
		'| --- | --- | --- | --- | --- | --- |',
		...(summary.productSlice ?? []).map(
			(row) =>
				`| ${row.id} | ${row.tokens} | ${row.waste} | ${row.suppress} | ${row.executeWhen} | ${row.maxMemories} |`,
		),
		'',
		'## Rubric',
		'',
		'- Hard fail: isolation < 1 (user-global hide) or memories on empty browse.',
		'- Core reliability: required traces except execute-only with no memoryContext.',
		'- Stretch: execute-only send with no retrieval hint. Hitting it forces execute-always or a verb trigger.',
		'- Reliability: all expectVisible traces, including stretch.',
		'- Incident: the original search-then-execute-send path with no memoryContext.',
		'- Compaction: echoed conversation after old search fell out of a 3-result window.',
		'- Tokens: memory markdown + structured JSON, chars/4, summed across all traces.',
		'- Composite: `100*rel + 20*incident + 10*compaction - tokens/200 - waste/400` (hard fail −1000).',
	]
	return lines.join('\n')
}

function formatWinner(row) {
	const slim = slimRow(row)
	return [
		`- **${slim.id}**`,
		`- composite ${slim.composite}; reliability ${slim.reliability}; incident ${slim.incident}; compaction ${slim.compaction}`,
		`- tokens ${slim.tokens}; waste ${slim.waste}; isolation ${slim.isolation}`,
		`- searchWhen=${slim.searchWhen} executeWhen=${slim.executeWhen} payload=${slim.payload} suppress=${slim.suppress} repeat=${slim.repeatForm} n=${slim.maxMemories}`,
	].join('\n')
}

async function main() {
	const extras = await loadExtras()
	const extraScenarios = await loadExtraScenarios()
	const policies = [
		...cartesianPolicies(),
		...verbAndAsymmetryPolicies(),
		...namedBaselines(),
		...extras,
	]
	const seen = new Set()
	const unique = []
	for (const policy of policies) {
		const key = policy.id ?? JSON.stringify(policy)
		if (seen.has(key)) continue
		seen.add(key)
		unique.push(policy)
	}
	const scenarios = [...baselineScenarios, ...extraScenarios]
	const rows = unique.map((policy) => scorePolicy(policy, scenarios))
	const summary = summarize(rows)
	summary.leaveOneOut = leaveOneOutWinners(unique, scenarios)
	const perfect = rows.filter((row) => !row.hardFail && !row.requiredMiss)
	summary.clusters = clusterWinners(perfect)
	summary.productSlice = perfect
		.filter(
			(row) =>
				row.policy.suppress !== 'user_global' &&
				['subject_summary', 'summary_80', 'stub_after_first'].includes(
					row.policy.payload,
				) &&
				row.policy.executeWhen !== 'always',
		)
		.sort((a, b) => a.tokens - b.tokens || a.waste - b.waste)
		.slice(0, 20)
		.map(slimRow)
	mkdirSync(outDir, { recursive: true })
	writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
	writeFileSync(join(outDir, 'report.md'), markdownReport(summary, scenarios))
	writeFileSync(
		join(outDir, 'top-rows.json'),
		JSON.stringify(summary.topComposite, null, 2),
	)
	const invented = rows
		.filter((row) => row.family === 'agent' || row.family === 'named')
		.sort((a, b) => b.composite - a.composite)
		.map(slimRow)
	writeFileSync(
		join(outDir, 'invented-scores.json'),
		JSON.stringify(invented, null, 2),
	)
	console.log(
		JSON.stringify(
			{
				total: summary.total,
				feasible: summary.feasible,
				perfect: summary.perfect,
				best: slimRow(summary.bestComposite),
				cheapestPerfect: summary.bestPerfectCheapest
					? slimRow(summary.bestPerfectCheapest)
					: null,
			},
			null,
			2,
		),
	)
}

await main()

import { expect, test } from 'vitest'
import {
	classifyReviewBotComment,
	classifyReviewBotComments,
	findingHasAddressingReply,
	invalidReplyBody,
	isAddressingReviewReply,
	isShipPrBlocker,
	reviewBotKind,
} from './classify-review-bot.mjs'

test('review-bot sort maps Bugbot, Devin, and Seer; unsure stays a blocker', () => {
	expect(reviewBotKind('cursor[bot]')).toBe('bugbot')
	expect(reviewBotKind('devin-ai-integration[bot]')).toBe('devin')
	expect(reviewBotKind('seer[bot]')).toBe('seer')
	expect(reviewBotKind('coderabbitai[bot]')).toBe(null)

	const valid = classifyReviewBotComment({
		id: 1,
		user: { login: 'cursor[bot]' },
		body: 'This is a bug: null pointer when the session is missing.',
		html_url: 'https://example.test/1',
	})
	expect(valid).not.toBeNull()
	expect(valid?.verdict).toBe('valid')
	expect(isShipPrBlocker(valid!)).toBe(true)

	const invalid = classifyReviewBotComment({
		id: 2,
		user: { login: 'devin-ai-integration[bot]' },
		body: 'Nit: rename this variable for style-only consistency.',
		html_url: 'https://example.test/2',
	})
	expect(invalid).not.toBeNull()
	expect(invalid?.verdict).toBe('invalid')
	expect(isShipPrBlocker(invalid!)).toBe(false)
	expect(invalidReplyBody(invalid!)).toMatch(/in-repo review-bot sort/)

	const optionalParameterBug = classifyReviewBotComment({
		id: 4,
		user: { login: 'cursor[bot]' },
		body: 'Bug: the optional `timeout` parameter is ignored; requests never time out.',
		html_url: 'https://example.test/4',
	})
	expect(optionalParameterBug).not.toBeNull()
	expect(optionalParameterBug?.verdict).toBe('valid')
	expect(isShipPrBlocker(optionalParameterBug!)).toBe(true)

	const optionalFixFinding = classifyReviewBotComment({
		id: 5,
		user: { login: 'devin-ai-integration[bot]' },
		body: 'This is an optional suggestion: rename for consistency.',
		html_url: 'https://example.test/5',
	})
	expect(optionalFixFinding).not.toBeNull()
	expect(optionalFixFinding?.verdict).toBe('invalid')
	expect(isShipPrBlocker(optionalFixFinding!)).toBe(false)

	const detailsWrappedBug = classifyReviewBotComment({
		id: 6,
		user: { login: 'devin-ai-integration[bot]' },
		body: [
			'Optional parameters hide real review findings',
			'',
			'When a bot reports a bug involving an optional parameter, classification drops it.',
			'<details><summary>Learn more</summary>',
			'Require explicit language that the finding itself is a nit or optional.',
			'</details>',
		].join('\n'),
		html_url: 'https://example.test/6',
	})
	expect(detailsWrappedBug).not.toBeNull()
	expect(detailsWrappedBug?.verdict).toBe('valid')
	expect(isShipPrBlocker(detailsWrappedBug!)).toBe(true)

	const mixedNitAndSecurity = classifyReviewBotComment({
		id: 7,
		user: { login: 'cursor[bot]' },
		body: 'This is not a nit: the security bug exposes credentials.',
		html_url: 'https://example.test/7',
	})
	expect(mixedNitAndSecurity).not.toBeNull()
	expect(mixedNitAndSecurity?.verdict).toBe('unsure')
	expect(isShipPrBlocker(mixedNitAndSecurity!)).toBe(true)

	const unsure = classifyReviewBotComment({
		id: 3,
		user: { login: 'seer[bot]' },
		body: 'Consider whether this helper belongs closer to the call site.',
		html_url: 'https://example.test/3',
	})
	expect(unsure).not.toBeNull()
	expect(unsure?.verdict).toBe('unsure')
	expect(isShipPrBlocker(unsure!)).toBe(true)

	const findings = classifyReviewBotComments([
		{
			id: 11,
			user: { login: 'cursor[bot]' },
			body: 'Critical security issue: credential logged in plaintext.',
		},
		{
			id: 12,
			user: { login: 'devin-ai-integration[bot]' },
			body: 'False positive - not a bug in this path.',
		},
		{
			id: 13,
			user: { login: 'seer[bot]' },
			body: 'Maybe revisit the naming here.',
		},
		{
			id: 14,
			user: { login: 'coderabbitai[bot]' },
			body: 'This is a bug that should be fixed.',
		},
	])
	expect(findings).toHaveLength(3)
	expect(findings.filter(isShipPrBlocker)).toHaveLength(2)
	expect(
		findings.filter((finding) => finding.verdict === 'invalid'),
	).toHaveLength(1)

	expect(
		isAddressingReviewReply({
			id: 21,
			user: { login: 'kody-bot' },
			body: 'Fixed in abcdef1 — the closed-world runtime now allowlists that warn.',
			in_reply_to_id: 1,
		}),
	).toBe(true)
	expect(
		isAddressingReviewReply({
			id: 22,
			user: { login: 'kentcdodds' },
			body: 'Intentional wontfix; leaving the fallback as-is.',
			in_reply_to_id: 3,
		}),
	).toBe(true)
	expect(
		isAddressingReviewReply({
			id: 23,
			user: { login: 'cursor[bot]' },
			body: 'Still a bug: fixed in abcdef1 would be nicer.',
			in_reply_to_id: 1,
		}),
	).toBe(false)
	expect(
		isAddressingReviewReply({
			id: 24,
			user: { login: 'kody-bot' },
			body: 'Looking at this now.',
			in_reply_to_id: 1,
		}),
	).toBe(false)
	expect(
		findingHasAddressingReply({ commentId: 1 }, [
			{
				id: 1,
				user: { login: 'cursor[bot]' },
				body: 'This is a bug: null pointer when the session is missing.',
			},
			{
				id: 21,
				user: { login: 'kody-bot' },
				body: 'Addressed in abcdef1.',
				in_reply_to_id: 1,
			},
		]),
	).toBe(true)
	expect(
		findingHasAddressingReply({ commentId: 3 }, [
			{
				id: 3,
				user: { login: 'seer[bot]' },
				body: 'Consider whether this helper belongs closer to the call site.',
			},
		]),
	).toBe(false)
})

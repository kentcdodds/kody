/**
 * Classify Bugbot / Devin / Seer pull-request review comments for ship-pr.
 *
 * Conservative rules: unsure stays a blocker (never auto-dismissed). Invalid
 * findings are safe to reply to and drop from the blocker list.
 */

export const reviewBotLogins = [
	'cursor',
	'bugbot',
	'devin-ai-integration',
	'devin',
	'seer',
	'seer-bot',
]

/** @typedef {'bugbot' | 'devin' | 'seer'} ReviewBotKind */

/**
 * @typedef {{
 *   bot: ReviewBotKind
 *   authorLogin: string
 *   commentId: number
 *   url?: string
 *   bodyPreview: string
 *   verdict: 'valid' | 'invalid' | 'unsure'
 *   reason: string
 * }} ReviewFinding
 */

/**
 * @typedef {{
 *   id: number
 *   user: { login: string }
 *   body: string
 *   html_url?: string
 *   in_reply_to_id?: number | null
 * }} ClassifiableComment
 */

/**
 * Human / kody-bot reply that cites a fixing commit or an intentional wontfix.
 * Review-bot authors and other automation never count.
 *
 * @param {unknown} text
 */
export function isAddressingReviewReplyBody(text) {
	const body = String(text ?? '')
	if (
		/\b(?:not|n't|never)\s+(?:been\s+)?(?:fixed|addressed|landed)\b/i.test(body)
	) {
		return false
	}
	if (/\b(wont\s*fix|won't fix|will not fix)\b/i.test(body)) {
		return true
	}
	return /\b(?:fixed|addressed|landed)\s+(?:in|by|with)\s+[0-9a-f]{7,40}\b/i.test(
		body,
	)
}

/**
 * kody-bot or a non-bot human. Review bots and other `*bot*` / `[bot]`
 * accounts cannot dismiss a finding.
 *
 * @param {unknown} login
 */
export function isAddressingReviewAuthor(login) {
	const raw = String(login ?? '')
	const normalized = normalizeBotLogin(raw)
	if (!normalized || reviewBotKind(raw)) return false
	if (normalized === 'kody-bot') return true
	if (/\[bot\]$/i.test(raw)) return false
	if (/(?:^|[-_])bot$/.test(normalized) || normalized.endsWith('bot')) {
		return false
	}
	return true
}

/**
 * @param {ClassifiableComment} comment
 */
export function isAddressingReviewReply(comment) {
	if (!isAddressingReviewAuthor(comment.user?.login)) return false
	return isAddressingReviewReplyBody(comment.body)
}

/**
 * @param {{ commentId: number }} finding
 * @param {Array<ClassifiableComment>} comments
 */
export function findingHasAddressingReply(finding, comments) {
	return comments.some(
		(comment) =>
			comment.in_reply_to_id === finding.commentId &&
			isAddressingReviewReply(comment),
	)
}

/**
 * @param {unknown} text
 * @param {number} maxLength
 */
export function truncate(text, maxLength) {
	const value = String(text ?? '')
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

/**
 * @param {unknown} login
 */
export function normalizeBotLogin(login) {
	return String(login ?? '')
		.toLowerCase()
		.replace(/\[bot\]$/i, '')
		.trim()
}

/**
 * @param {unknown} login
 * @returns {ReviewBotKind | null}
 */
export function reviewBotKind(login) {
	const normalized = normalizeBotLogin(login)
	if (!normalized) return null
	if (
		normalized === 'cursor' ||
		normalized === 'bugbot' ||
		normalized.startsWith('cursor-') ||
		normalized.startsWith('bugbot')
	) {
		return 'bugbot'
	}
	if (
		normalized === 'devin' ||
		normalized === 'devin-ai-integration' ||
		normalized.startsWith('devin')
	) {
		return 'devin'
	}
	if (
		normalized === 'seer' ||
		normalized === 'seer-bot' ||
		normalized.startsWith('seer')
	) {
		return 'seer'
	}
	return null
}

/**
 * @param {ClassifiableComment} comment
 * @returns {ReviewFinding | null}
 */
export function classifyReviewBotComment(comment) {
	const bot = reviewBotKind(comment.user.login)
	if (!bot) return null

	// Devin (and similar) wrap guidance in <details>; classify the finding
	// summary only so instructional words like "nit" in the docs do not
	// dismiss a real defect.
	const body = String(comment.body || '')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<details[\s\S]*?<\/details>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
	const preview = truncate(body.replace(/\s+/g, ' ').trim(), 160)

	const invalidMatchers = [
		{
			re: /\b(false\s*positive|not\s+a\s+bug|not\s+a\s+real\s+issue)\b/i,
			reason: 'comment self-identifies as false positive / not a bug',
		},
		{
			// Require finding-level optionality. Bare "optional" matches technical
			// wording ("optional parameter") and must not dismiss a real defect.
			re: /\b(nit|nitpick|style[- ]only|cosmetic|(this\s+is\s+)?optional\s+(fix|change|suggestion|nit))\b/i,
			reason: 'nit / optional / style-only signal',
		},
		{
			re: /\b(already\s+fixed|no\s+longer\s+applies|outdated\s+suggestion)\b/i,
			reason: 'already fixed / outdated suggestion',
		},
		{
			re: /\b(ignore\s+this|can\s+safely\s+ignore|no\s+action\s+needed)\b/i,
			reason: 'explicit no-action guidance',
		},
	]

	const validMatchers = [
		{
			re: /\b(security|vulnerab|injection|xss|csrf|secret|credential|rce)\b/i,
			reason: 'security-related finding',
		},
		{
			// Do not treat "not a bug" as a defect claim.
			re: /\b((?<!not\s+a\s)bug|incorrect|broken|crash|regress|race\s+condition|null\s+pointer|type\s+error)\b/i,
			reason: 'defect / correctness claim',
		},
		{
			re: /\b(must\s+fix|needs?\s+to\s+be\s+fixed|high\s+severity|critical)\b/i,
			reason: 'explicit fix-required language',
		},
	]

	/** @type {{ reason: string } | null} */
	let invalidHit = null
	for (const matcher of invalidMatchers) {
		if (matcher.re.test(body)) {
			invalidHit = { reason: matcher.reason }
			break
		}
	}

	/** @type {{ reason: string } | null} */
	let validHit = null
	for (const matcher of validMatchers) {
		if (matcher.re.test(body)) {
			validHit = { reason: matcher.reason }
			break
		}
	}

	// Mixed signals stay unsure so incidental "nit"/"optional" wording cannot
	// dismiss a real defect claim.
	if (invalidHit && validHit) {
		return {
			bot,
			authorLogin: comment.user.login,
			commentId: comment.id,
			url: comment.html_url,
			bodyPreview: preview,
			verdict: 'unsure',
			reason: 'mixed invalid and valid signals - treat as valid',
		}
	}

	if (invalidHit) {
		return {
			bot,
			authorLogin: comment.user.login,
			commentId: comment.id,
			url: comment.html_url,
			bodyPreview: preview,
			verdict: 'invalid',
			reason: invalidHit.reason,
		}
	}

	if (validHit) {
		return {
			bot,
			authorLogin: comment.user.login,
			commentId: comment.id,
			url: comment.html_url,
			bodyPreview: preview,
			verdict: 'valid',
			reason: validHit.reason,
		}
	}

	return {
		bot,
		authorLogin: comment.user.login,
		commentId: comment.id,
		url: comment.html_url,
		bodyPreview: preview,
		verdict: 'unsure',
		reason: 'insufficient signal - treat as valid',
	}
}

/**
 * @param {Array<ClassifiableComment>} comments
 * @returns {Array<ReviewFinding>}
 */
export function classifyReviewBotComments(comments) {
	/** @type {Array<ReviewFinding>} */
	const findings = []
	for (const comment of comments) {
		const finding = classifyReviewBotComment(comment)
		if (finding) findings.push(finding)
	}
	return findings
}

/**
 * @param {ReviewFinding} finding
 */
export function isShipPrBlocker(finding) {
	return finding.verdict === 'valid' || finding.verdict === 'unsure'
}

/**
 * @param {ReviewFinding} finding
 */
export function invalidReplyBody(finding) {
	const botLabel =
		finding.bot === 'bugbot'
			? 'Bugbot'
			: finding.bot === 'devin'
				? 'Devin'
				: finding.bot === 'seer'
					? 'Seer'
					: 'review bot'
	return [
		`Marked **invalid** for ship-pr by the in-repo review-bot sort (${botLabel}: ${finding.reason}).`,
		'Not treated as a merge blocker. Re-open the thread if this was wrong.',
	].join('\n')
}

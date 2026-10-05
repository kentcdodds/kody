#!/usr/bin/env node
/**
 * Sort Bugbot / Devin / Seer PR review comments for ship-pr.
 *
 * Reads comments via `gh api`, classifies them, optionally posts short
 * kody-bot replies on invalid findings via `kody:@kentcdodds/github/request`
 * (prefer-local CLI execute).
 *
 * Usage:
 *   node .agents/skills/ship-pr/scripts/sort-review-bot-comments.mjs \
 *     --pr-url https://github.com/kentcdodds/kody/pull/1 [--dry-run]
 *   node .agents/skills/ship-pr/scripts/sort-review-bot-comments.mjs \
 *     --owner kentcdodds --repo kody --pr 1 --skip-replies
 */
import { execFileSync } from 'node:child_process'
import {
	classifyReviewBotComments,
	findingHasAddressingReply,
	invalidReplyBody,
	isShipPrBlocker,
} from './classify-review-bot.mjs'

const args = process.argv.slice(2)

/** Marker used to detect an existing dismissal reply in the thread. */
const invalidReplyMarker =
	'Marked **invalid** for ship-pr by the in-repo review-bot sort'

function readFlag(name) {
	const index = args.indexOf(name)
	if (index === -1) return null
	const value = args[index + 1]
	if (!value || value.startsWith('--')) {
		console.error(`missing value for ${name}`)
		process.exit(1)
	}
	return value
}

function parsePrUrl(prUrl) {
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
	if (!match) return null
	return {
		owner: match[1],
		repo: match[2],
		prNumber: Number(match[3]),
	}
}

function usage() {
	console.error(`Usage:
  node .agents/skills/ship-pr/scripts/sort-review-bot-comments.mjs --pr-url <url> [--dry-run] [--skip-replies]
  node .agents/skills/ship-pr/scripts/sort-review-bot-comments.mjs --owner <o> --repo <r> --pr <n> [--dry-run] [--skip-replies]`)
	process.exit(1)
}

/**
 * @param {{ owner: string, repo: string, prNumber: number }} input
 */
function loadPullReviewComments({ owner, repo, prNumber }) {
	/**
	 * @type {Array<{
	 *   id: number
	 *   user: { login: string }
	 *   body: string
	 *   html_url?: string
	 *   in_reply_to_id?: number | null
	 * }>}
	 */
	const comments = []
	for (let page = 1; ; page += 1) {
		const path = `repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`
		const raw = execFileSync('gh', ['api', path], {
			encoding: 'utf8',
			// A full page of 100 review comments with bodies can exceed Node's
			// default 1 MiB maxBuffer and abort before any findings print.
			maxBuffer: 16 * 1024 * 1024,
		})
		const pageItems = JSON.parse(raw)
		if (!Array.isArray(pageItems)) {
			throw new Error(`Unexpected GitHub comments payload for ${path}`)
		}
		for (const item of pageItems) {
			if (!item?.id || !item.user?.login) continue
			comments.push({
				id: item.id,
				user: { login: item.user.login },
				body: String(item.body || ''),
				html_url: item.html_url,
				in_reply_to_id:
					typeof item.in_reply_to_id === 'number' ? item.in_reply_to_id : null,
			})
		}
		if (pageItems.length < 100) break
	}
	return comments
}

function alreadyHasInvalidReply(comments, commentId) {
	return comments.some(
		(comment) =>
			comment.in_reply_to_id === commentId &&
			comment.body.includes(invalidReplyMarker),
	)
}

function replyToPullReviewComment({
	owner,
	repo,
	prNumber,
	commentId,
	body,
	dryRun,
}) {
	if (dryRun) {
		return { ok: true, dryRun: true }
	}
	const code = `
import githubRequest from 'kody:@kentcdodds/github/request'

export default async function main(params) {
	const path = \`/repos/\${params.owner}/\${params.repo}/pulls/\${params.prNumber}/comments/\${params.commentId}/replies\`
	const result = await githubRequest({
		account: 'bot',
		path,
		method: 'POST',
		body: { body: params.body },
	})
	if (result?.ok === false || (result.status && result.status >= 400)) {
		throw new Error(
			\`GitHub \${path} failed (\${result.status}): \${String(result.text || '').slice(0, 200)}\`,
		)
	}
	return { ok: true }
}
`.trim()
	const paramsJson = JSON.stringify({ owner, repo, prNumber, commentId, body })
	execFileSync(
		'npx',
		[
			'@kodycodes/cli',
			'execute',
			'--local',
			'--code',
			code,
			'--params',
			paramsJson,
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	)
	return { ok: true }
}

const fromUrl = readFlag('--pr-url') ? parsePrUrl(readFlag('--pr-url')) : null
const owner = readFlag('--owner') || fromUrl?.owner
const repo = readFlag('--repo') || fromUrl?.repo
const prRaw = readFlag('--pr')
const prNumber = prRaw ? Number(prRaw) : fromUrl?.prNumber
const dryRun = args.includes('--dry-run')
const skipReplies = args.includes('--skip-replies') || dryRun

if (!owner || !repo || !prNumber) usage()

const comments = loadPullReviewComments({ owner, repo, prNumber })
const topLevelComments = comments.filter((comment) => !comment.in_reply_to_id)
const findings = classifyReviewBotComments(topLevelComments)
const invalid = findings.filter((finding) => finding.verdict === 'invalid')
const valid = findings.filter(isShipPrBlocker)
const alreadyAddressed = valid.filter((finding) =>
	findingHasAddressingReply(finding, comments),
)
const mustAddress = valid.filter(
	(finding) => !findingHasAddressingReply(finding, comments),
)

let replied = 0
let skippedAlreadyReplied = 0
if (!skipReplies) {
	for (const finding of invalid) {
		if (alreadyHasInvalidReply(comments, finding.commentId)) {
			skippedAlreadyReplied += 1
			continue
		}
		const result = replyToPullReviewComment({
			owner,
			repo,
			prNumber,
			commentId: finding.commentId,
			body: invalidReplyBody(finding),
			dryRun: false,
		})
		if (result.ok) replied += 1
	}
}
skippedAlreadyReplied += alreadyAddressed.length

const result = {
	ok: true,
	owner,
	repo,
	prNumber,
	dryRun,
	skipReplies,
	valid,
	invalid,
	replied,
	skippedAlreadyReplied,
	alreadyAddressed,
	/** ship-pr should address these (valid + unsure, not yet replied). */
	mustAddress,
}

console.log(JSON.stringify(result, null, 2))

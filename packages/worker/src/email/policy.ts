import {
	type EmailPolicyEvaluation,
	type EmailSenderPolicyRecord,
	type EmailPolicyDecision,
	type EmailPolicyKind,
} from './types.ts'
import { normalizeEmailAddress } from './address.ts'

type EvaluateSenderPolicyInput = {
	fromAddress: string | null
	envelopeFrom: string | null
	replyToken?: string | null
	rules: ReadonlyArray<EmailSenderPolicyRecord>
	defaultDecision?: EmailPolicyDecision
}

function getSenderCandidates(input: {
	fromAddress: string | null
	envelopeFrom: string | null
}) {
	return [input.fromAddress, input.envelopeFrom]
		.map((value) => (value ? normalizeEmailAddress(value) : null))
		.filter((value): value is string => value !== null)
}

function getDomain(address: string) {
	const separator = address.lastIndexOf('@')
	return separator === -1 ? null : address.slice(separator + 1)
}

function decisionFromRule(rule: EmailSenderPolicyRecord): EmailPolicyDecision {
	switch (rule.effect) {
		case 'allow':
			return 'accepted'
		case 'quarantine':
			return 'quarantined'
		case 'reject':
			return 'rejected'
		default: {
			const exhaustive: never = rule.effect
			throw new Error(`Unsupported email policy effect: ${exhaustive}`)
		}
	}
}

function matchSenderPolicyRule(input: {
	rule: EmailSenderPolicyRecord
	senderCandidates: ReadonlyArray<string>
	replyTokenHash: string | null
}) {
	const value = input.rule.value.trim().toLowerCase()
	switch (input.rule.kind) {
		case 'sender':
			return input.senderCandidates.some((candidate) => candidate === value)
		case 'domain':
			return input.senderCandidates.some((candidate) => getDomain(candidate) === value)
		case 'reply_token':
			return input.replyTokenHash !== null && input.replyTokenHash === value
		default: {
			const exhaustive: never = input.rule.kind
			throw new Error(`Unsupported email policy kind: ${exhaustive}`)
		}
	}
}

function createDecision(input: {
	decision: EmailPolicyDecision
	reason: string
	rule: EmailSenderPolicyRecord | null
}): EmailPolicyEvaluation {
	return {
		decision: input.decision,
		reasons: [input.reason],
		ruleId: input.rule?.id ?? null,
		policyKind: input.rule?.kind ?? null,
	}
}

function sortPolicyRules(rules: ReadonlyArray<EmailSenderPolicyRecord>) {
	const order: Record<EmailPolicyKind, number> = {
		reply_token: 0,
		sender: 1,
		domain: 2,
	}
	return [...rules]
		.filter((rule) => rule.enabled)
		.sort((left, right) => order[left.kind] - order[right.kind])
}

export async function evaluateSenderPolicy(
	input: EvaluateSenderPolicyInput,
): Promise<EmailPolicyEvaluation> {
	const senderCandidates = getSenderCandidates(input)
	const replyTokenHash = input.replyToken?.trim().toLowerCase() || null
	for (const rule of sortPolicyRules(input.rules)) {
		if (
			matchSenderPolicyRule({
				rule,
				senderCandidates,
				replyTokenHash,
			})
		) {
			return createDecision({
				decision: decisionFromRule(rule),
				reason: `Matched ${rule.kind} policy.`,
				rule,
			})
		}
	}
	const fallback = input.defaultDecision ?? 'quarantined'
	switch (fallback) {
		case 'accepted':
		case 'quarantined':
		case 'rejected':
			return createDecision({
				decision: fallback,
				reason: 'No sender policy matched.',
				rule: null,
			})
		default: {
			const exhaustive: never = fallback
			throw new Error(`Unsupported default email policy decision: ${exhaustive}`)
		}
	}
}

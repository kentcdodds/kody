import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultFrictionLogPolicyPath = path.join(
	'docs',
	'contributing',
	'friction-log.md',
)

export const retiredHtmlSkipMarker = 'friction-log:skipped'
export const frictionSkippedLabel = 'friction-skipped'
export const packageOwnershipPhrase =
	'Daily agent instructions (outcomes, skip/unskip, record-outcome) come from the package'

export type FrictionLogPolicyCheckResult = {
	ok: boolean
	errors: Array<string>
}

function flattenWs(content: string): string {
	return content.replace(/\s+/g, ' ')
}

/**
 * Keep the contributing friction-log page aligned with label-based skip and
 * package ownership of daily/API behavior. This repo owns the short policy
 * stub; @kentcdodds/friction-log owns runtime eligibility and agent prompts.
 */
export function checkFrictionLogPolicyContent(
	content: string,
): FrictionLogPolicyCheckResult {
	const errors: Array<string> = []
	const flat = flattenWs(content)

	if (content.includes(retiredHtmlSkipMarker)) {
		errors.push(
			`Policy must not mention the retired HTML skip marker ${retiredHtmlSkipMarker}. Use the ${frictionSkippedLabel} GitHub label.`,
		)
	}
	if (content.includes('<!-- friction')) {
		errors.push(
			'Policy must not use an HTML comment as the skip gate. Use the friction-skipped GitHub label.',
		)
	}
	if (!content.includes(`\`${frictionSkippedLabel}\``)) {
		errors.push(
			`Policy must document the \`${frictionSkippedLabel}\` GitHub label.`,
		)
	}
	if (
		!/Daily sweep eligibility is:\s*open \+ `friction` \+ NOT\s*`friction-skipped`/.test(
			flat,
		)
	) {
		errors.push(
			'Policy must describe daily sweep eligibility as open + `friction` + NOT `friction-skipped`.',
		)
	}
	if (
		!/apply the GitHub label\s*`friction-skipped`/.test(flat) &&
		!/Apply the GitHub label\s*`friction-skipped`/.test(flat)
	) {
		errors.push(
			'Policy must tell agents to apply the `friction-skipped` label on skip.',
		)
	}
	if (!/remove `friction-skipped`/.test(flat)) {
		errors.push(
			'Policy must tell agents to remove `friction-skipped` when unskipping or acting on Kent reply.',
		)
	}
	if (!/does not scrape issue comments/.test(flat)) {
		errors.push(
			'Policy must state that eligibility does not scrape issue comments.',
		)
	}
	if (!/no `\.github\/labels\.yml`/.test(flat)) {
		errors.push(
			'Policy must note that labels are not defined in-tree (no .github/labels.yml).',
		)
	}
	if (!flat.includes(packageOwnershipPhrase)) {
		errors.push(
			'Policy must state that daily agent instructions come from the package when spawned.',
		)
	}
	if (!content.includes('kody.codes/@kentcdodds/friction-log')) {
		errors.push(
			'Policy must point at https://kody.codes/@kentcdodds/friction-log for package ownership.',
		)
	}

	return { ok: errors.length === 0, errors }
}

export async function checkFrictionLogPolicy(
	policyPath: string = defaultFrictionLogPolicyPath,
): Promise<FrictionLogPolicyCheckResult> {
	const content = await readFile(policyPath, 'utf8')
	return checkFrictionLogPolicyContent(content)
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await checkFrictionLogPolicy()
	if (!result.ok) {
		for (const error of result.errors) {
			console.error(error)
		}
		process.exitCode = 1
	}
}

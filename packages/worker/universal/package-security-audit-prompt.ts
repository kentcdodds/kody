export const packageSecurityAuditAnchor = 'security-audit'
export const packageSecurityAuditSummaryMaxLength = 4000
export const packageSecurityAuditAuditorMaxLength = 120
export const packageSecurityAuditRecordOperation = 'packageSecurityAuditRecord'

export function packageSecurityAuditRecordHttpRoute(packageId: string) {
	return `POST /v1/packages/${encodeURIComponent(packageId)}/security-audits`
}

export type PackageSecurityAuditPromptInput = {
	packageName: string
	packageId: string
	publishedCommit: string
	fingerprint: string
	approvalUrl: string
}

/**
 * Copyable prompt the owner hands to their agent. Raw ids live here (and in
 * the page Details disclosure) so the visible page stays plain-language.
 */
export function buildPackageSecurityAuditPrompt(
	input: PackageSecurityAuditPromptInput,
): string {
	return [
		`Please run a security audit of my Kody package ${input.packageName} before I approve its capabilities.`,
		'',
		'Audit exactly this published version:',
		`- package_id: ${input.packageId}`,
		`- published_commit: ${input.publishedCommit}`,
		`- capability fingerprint: ${input.fingerprint}`,
		`- approval page: ${input.approvalUrl}`,
		'',
		'Get the source at that commit (Kody `packageGetGitRemote` gives a clone URL), then review the code for:',
		'1. Declared vs used credentials: every credential the package or its dependencies declare, whether the code actually uses it, and whether anything uses a credential it did not declare.',
		'2. Leaked credentials: API keys, tokens, passwords, or private data committed in source, config, fixtures, or logs.',
		'3. Unintended public exposure: app routes, exports, or responses that would reveal private data or credentials to anyone on the internet.',
		'4. Risky network hosts: every host credentials can be sent to or the code fetches from, and whether each is expected for what the package does.',
		'5. Storage use: what the package writes to package storage and whether any of it is sensitive.',
		'',
		`Then record the result with the Kody operation \`${packageSecurityAuditRecordOperation}\` (Kody MCP \`api\` or \`execute\`, \`kody execute\`, or Open API \`${packageSecurityAuditRecordHttpRoute(input.packageId)}\`) using:`,
		`- package_id: "${input.packageId}"`,
		`- published_commit: "${input.publishedCommit}"`,
		`- fingerprint: "${input.fingerprint}"`,
		'- verdict: "pass" if nothing concerning, otherwise "concerns"',
		'- summary: a short plain-language summary for me of what you checked and found (never include credential values)',
		'- auditor: your name as an agent (optional)',
		'',
		'For example, in Kody execute:',
		`kody.${packageSecurityAuditRecordOperation}({ package_id: "${input.packageId}", published_commit: "${input.publishedCommit}", fingerprint: "${input.fingerprint}", verdict: "pass", summary: "…" })`,
		'',
		`When it is recorded, send me the approval page link (${input.approvalUrl}). Recording the audit is informational only. Do not approve capabilities or change package settings; I will approve on the website myself.`,
	].join('\n')
}

/**
 * Phase 2 of issue #3836: seal credential stamps on published packages by
 * declaring stamp keys in `kody.credentials` with inferred descriptions where
 * possible (literal MCP servers, OAuth/integration names, signing keys).
 * Packages with unstampable patterns or uninferable secret descriptions are
 * reported as `needs_manual` for an agent conversion attempt.
 */
import {
	applyCredentialStampSealPlan,
	planCredentialStampSeal,
} from '#worker/credentials/credential-stamp.ts'
import {
	type PackageCodemod,
	type PackageCodemodContext,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const sealCredentialStampsCodemodId = '0014-seal-credential-stamps'

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a credential name, file contents, or manifest values.
 */
export const sealCredentialStampsMessages = {
	declare:
		'Uses stamped credentials that kody.credentials does not declare with a description. This codemod fills inferred descriptions (MCP servers, OAuth accounts, signing keys) and leaves other keys for manual review.',
	unconvertible:
		'Has credential patterns the stamp gate cannot seal (non-literal names, |scope=, secretMounts, packageSecrets.get, credential.named, server eval, dynamic kody.mcp, or invalid keys). Convert to literal stamped uses by hand, then republish.',
	uninferable:
		'Has stamped credential keys whose purpose cannot be inferred from source. Write a real description in kody.credentials for each, then republish.',
} as const

function detectSealCredentialStamps(
	files: Record<string, string>,
	_context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const plan = planCredentialStampSeal(files)
	const findings: Array<PackageCodemodFinding> = []
	if (plan.updates.length > 0) {
		findings.push({
			path: 'package.json',
			message: sealCredentialStampsMessages.declare,
		})
	}
	if (plan.blockingFailures.length > 0) {
		findings.push({
			path: plan.blockingFailures[0]?.path ?? null,
			message: sealCredentialStampsMessages.unconvertible,
		})
	}
	if (plan.uninferableKeys.length > 0) {
		findings.push({
			path: 'package.json',
			message: sealCredentialStampsMessages.uninferable,
		})
	}
	return findings
}

function transformSealCredentialStamps(
	files: Record<string, string>,
	_context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const plan = planCredentialStampSeal(files)
	const needsManual: Array<PackageCodemodFinding> = []
	if (plan.blockingFailures.length > 0) {
		needsManual.push({
			path: plan.blockingFailures[0]?.path ?? null,
			message: sealCredentialStampsMessages.unconvertible,
		})
	}
	if (plan.uninferableKeys.length > 0) {
		needsManual.push({
			path: 'package.json',
			message: sealCredentialStampsMessages.uninferable,
		})
	}
	if (plan.updates.length === 0) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual,
		}
	}
	const applied = applyCredentialStampSealPlan(files, plan)
	if (!applied.changed) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual,
		}
	}
	return {
		files: applied.files,
		changed: true,
		changedPaths: ['package.json'],
		needsManual,
	}
}

/**
 * Fleet seal for issue #3836 phase 2: write inferred `kody.credentials`
 * descriptions for stampable literal uses (including MCP server names), then
 * republish so `storePublishedCredentialStamp` seals the sidecar. packages
 * that still need a human description or cannot be stamped stay
 * `needs_manual`.
 */
export const sealCredentialStampsCodemod: PackageCodemod = {
	id: sealCredentialStampsCodemodId,
	description:
		'Seal credential stamps for published packages: declare missing kody.credentials slots with inferred descriptions for literal MCP servers, OAuth accounts, and signing keys; flag unconvertible patterns and uninferable secret descriptions for manual review (issue #3836 phase 2).',
	applyMode: 'published-only',
	detect: detectSealCredentialStamps,
	transform: transformSealCredentialStamps,
}

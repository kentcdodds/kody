import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	packageInvokePrefixlessEvidenceEpoch,
	type PackageInvokeEvidenceSurface,
} from '#universal/package-invoke-prefixless-evidence.ts'

export type PackageInvokePrefixlessEvidenceEnv = {
	USER_METER?: DurableObjectNamespace
}

/**
 * Fail-closed exact evidence for a validated deprecated invocation. There is
 * deliberately no retry: without storing a per-call identity, an ambiguous
 * retry could double count. Either outcome is conservative for the zero gate,
 * but the caller must not continue after an uncertain write.
 */
export async function recordPackageInvokePrefixlessEvidence(input: {
	env: PackageInvokePrefixlessEvidenceEnv
	userId: string
	surface: PackageInvokeEvidenceSurface
}): Promise<void> {
	try {
		const result = await userMeterRpc({
			env: input.env,
			userId: input.userId,
		}).recordPackageInvokePrefixless({
			epoch: packageInvokePrefixlessEvidenceEpoch,
			surface: input.surface,
		})
		if (!result.recorded) {
			throw new Error('UserMeter did not confirm exact evidence recording.')
		}
	} catch (cause) {
		throw new Error(
			'Deprecated prefixless packages.invoke could not record exact migration evidence. Retry with a kody: prefix.',
			{ cause },
		)
	}
}

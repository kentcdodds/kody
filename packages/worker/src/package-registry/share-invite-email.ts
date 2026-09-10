import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildPackageShareInviteEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import {
	buildPackageShareAcceptPath,
	hydratePackageShareGrantView,
	type PackageShareGrantRow,
} from './share-grants.ts'

export async function sendPackageShareInviteEmail(input: {
	env: Env
	requestUrl: string
	grant: PackageShareGrantRow
}) {
	const view = await hydratePackageShareGrantView({
		db: input.env.APP_DB,
		grant: input.grant,
	})
	const emailConfig = resolveTransactionalEmailConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	if (!emailConfig || !view.inviteeEmail) return { sent: false }
	const acceptPath = buildPackageShareAcceptPath({
		ownerUsername: view.ownerUsername,
		kodyId: view.packageKodyId,
	})
	const acceptUrl = new URL(acceptPath, emailConfig.appBaseUrl).toString()
	const existingAccount = view.granteeUserId != null
	const email = buildPackageShareInviteEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		ownerUsername: view.ownerUsername,
		packageName: view.packageName,
		acceptUrl,
		existingAccount,
	})
	const sendResult = await sendCloudflareEmail(
		{
			accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
			apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
			apiToken: input.env.CLOUDFLARE_API_TOKEN,
		},
		{
			to: view.inviteeEmail,
			from: emailConfig.fromEmail,
			subject: email.subject,
			html: email.html,
			text: email.text,
		},
	)
	if (
		!sendResult.ok &&
		!(sendResult.skipped && isNonProductionRuntime(input.env))
	) {
		console.error('package-share-invite-email-failed', sendResult.error)
	}
	return { sent: sendResult.ok === true }
}

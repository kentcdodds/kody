import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type ConnectWebhookApplyLoaderData } from '#universal/loader-data.ts'
import {
	approveWebhookApplyDestination,
	loadWebhookApplyDestinationApprovalView,
	rejectWebhookApplyDestination,
} from '#worker/webhooks/apply-destination-approval.ts'
import { parseWebhookUrlHandle } from '#worker/webhooks/handle.ts'

function readApprovalQuery(requestUrl: string) {
	const url = new URL(requestUrl)
	return {
		handle: url.searchParams.get('handle')?.trim() || null,
		fingerprint: url.searchParams.get('fingerprint')?.trim() || null,
	}
}

export async function loadConnectWebhookApplyData(input: {
	env: Env
	user: AuthenticatedAppUser
	requestUrl: string
}): Promise<ConnectWebhookApplyLoaderData> {
	const { handle, fingerprint } = readApprovalQuery(input.requestUrl)
	if (!handle || !fingerprint) {
		return {
			ok: false,
			error: 'This approval link is missing handle or fingerprint.',
			handle,
			fingerprint,
		}
	}

	const view = await loadWebhookApplyDestinationApprovalView({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		handle,
		fingerprint,
	})
	if (!view) {
		return {
			ok: false,
			error:
				'No pending or approved webhook apply destination matches this link.',
			handle,
			fingerprint,
		}
	}

	return {
		ok: true,
		handle: view.handle,
		fingerprint: view.fingerprint,
		packageId: view.packageId,
		packageKodyId: view.packageKodyId,
		packageName: view.packageName,
		webhookName: view.webhookName,
		destination: view.destination,
		alreadyGranted: view.alreadyGranted,
	}
}

export async function approveConnectWebhookApply(input: {
	env: Env
	user: AuthenticatedAppUser
	handle: string
	fingerprint: string
}): Promise<ConnectWebhookApplyLoaderData> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		return {
			ok: false,
			error: 'Invalid webhook handle.',
			handle: input.handle,
			fingerprint: input.fingerprint,
		}
	}
	await approveWebhookApplyDestination({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		endpointId,
		fingerprint: input.fingerprint,
	})
	return loadConnectWebhookApplyData({
		env: input.env,
		user: input.user,
		requestUrl: `https://kody.invalid/connect/webhook-apply?handle=${encodeURIComponent(input.handle)}&fingerprint=${encodeURIComponent(input.fingerprint)}`,
	})
}

export async function rejectConnectWebhookApply(input: {
	env: Env
	user: AuthenticatedAppUser
	handle: string
	fingerprint: string
}): Promise<ConnectWebhookApplyLoaderData> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		return {
			ok: false,
			error: 'Invalid webhook handle.',
			handle: input.handle,
			fingerprint: input.fingerprint,
		}
	}
	await rejectWebhookApplyDestination({
		db: input.env.APP_DB,
		userId: input.user.mcpUser.userId,
		endpointId,
		fingerprint: input.fingerprint,
	})
	return {
		ok: false,
		error: 'Approval rejected. The agent must request a new approval link.',
		handle: input.handle,
		fingerprint: input.fingerprint,
	}
}

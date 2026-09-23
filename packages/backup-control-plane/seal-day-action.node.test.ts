import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'

import { test, vi } from 'vitest'

import {
	encodeJwtPartForTests,
	resetAccessJwksCacheForTests,
} from './access-auth.ts'
import {
	encodeNodeBytesAsBase64,
	environment,
} from './backup-control-plane-test-support.ts'
import { workflowBackupErrorMessage } from './backup-policy.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'
import * as sealFullBackup from './seal-full-backup.ts'
import { sealDayWorkflowInstanceId } from './seal-day-run.ts'

function rsaJwksAndSigner() {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
	})
	const jwk = publicKey.export({ format: 'jwk' })
	const kid = 'seal-route-kid'
	return {
		kid,
		jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
		sign(header: Record<string, unknown>, payload: Record<string, unknown>) {
			const encoded = `${encodeJwtPartForTests(header)}.${encodeJwtPartForTests(payload)}`
			const signer = createSign('RSA-SHA256')
			signer.update(encoded)
			signer.end()
			const signature = encodeNodeBytesAsBase64(signer.sign(privateKey))
				.replaceAll('+', '-')
				.replaceAll('/', '_')
				.replaceAll('=', '')
			return `${encoded}.${signature}`
		},
	}
}

type SealInstance = {
	status: 'queued' | 'running' | 'complete' | 'errored' | 'terminated'
	output?: unknown
	error?: { name: string; message: string }
}

function sealWorkflowDouble() {
	const created: Array<{ id: string; params: { day: string } }> = []
	let instance: SealInstance | null = null
	let restarts = 0
	const workflow = {
		async create(options: { id: string; params: { day: string } }) {
			if (instance) throw new Error('instance already exists')
			created.push(options)
			instance = { status: 'queued' }
		},
		async get(id: string) {
			if (!instance || created[0]?.id !== id) {
				throw new Error(`missing seal instance ${id}`)
			}
			return {
				async status() {
					return instance!
				},
				async restart() {
					restarts += 1
					instance = { status: 'queued' }
				},
			}
		},
	}
	return {
		workflow,
		created,
		restartCount: () => restarts,
		setInstance(next: SealInstance) {
			instance = next
		},
	}
}

test('seal day enqueues a workflow and status reports progress, already sealed, and incomplete', async () => {
	resetAccessJwksCacheForTests()
	const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const sealSpy = vi.spyOn(sealFullBackup, 'sealFullBackupDay')
	const { kid, jwks, sign } = rsaJwksAndSigner()
	const env = environment()
	const double = sealWorkflowDouble()
	env.SEAL_WORKFLOW = double.workflow as unknown as Workflow
	const day = '2026-09-22'
	const instanceId = sealDayWorkflowInstanceId(day)
	const now = Math.floor(Date.now() / 1000)
	const jwt = sign(
		{ alg: 'RS256', kid },
		{
			iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
			aud: env.ACCESS_APP_AUD,
			email: env.ACCESS_ALLOWED_EMAIL,
			iat: now - 5,
			exp: now + 3600,
		},
	)
	const fetcher = async () => Response.json(jwks)
	const authedGet = (path: string) =>
		new Request(`https://backup.example${path}`, {
			headers: { 'cf-access-jwt-assertion': jwt },
		})
	const authedPost = (body: string) =>
		new Request('https://backup.example/actions/seal-day', {
			method: 'POST',
			headers: {
				'cf-access-jwt-assertion': jwt,
				'sec-fetch-site': 'same-origin',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body,
		})

	const enqueued = await handleControlPlaneFetch(
		authedPost(`day=${day}`),
		env,
		fetcher,
	)
	assert.equal(enqueued.status, 303)
	assert.equal(
		enqueued.headers.get('location'),
		`https://backup.example/seal-status?id=${instanceId}`,
	)
	assert.equal(await enqueued.text(), '')
	assert.deepEqual(double.created, [{ id: instanceId, params: { day } }])
	assert.equal(sealSpy.mock.calls.length, 0)
	assert.equal(double.restartCount(), 0)
	const enqueueLog = JSON.parse(String(consoleLog.mock.calls.at(-1)?.[0])) as {
		event: string
		instanceId: string
		day: string
	}
	assert.equal(enqueueLog.event, 'ui-seal-day')
	assert.equal(enqueueLog.instanceId, instanceId)
	assert.equal(enqueueLog.day, day)

	const pending = await handleControlPlaneFetch(
		authedGet(`/seal-status?id=${instanceId}`),
		env,
		fetcher,
	)
	assert.equal(pending.status, 200)
	const pendingHtml = await pending.text()
	assert.match(pendingHtml, /Seal for 2026-09-22 is queued/)
	assert.match(pendingHtml, /http-equiv="refresh"/)
	assert.equal(pendingHtml.includes('was already sealed'), false)
	assert.equal(pendingHtml.includes('not ready to seal'), false)

	double.setInstance({
		status: 'complete',
		output: {
			kind: 'sealed',
			day,
			manifestKey: `daily/full/${day}/manifest.json`,
			alreadySealed: true,
		},
	})
	const sealed = await handleControlPlaneFetch(
		authedGet(`/seal-status?id=${instanceId}`),
		env,
		fetcher,
	)
	assert.equal(sealed.status, 200)
	const sealedHtml = await sealed.text()
	assert.match(
		sealedHtml,
		/Day 2026-09-22 was already sealed at daily\/full\/2026-09-22\/manifest\.json/,
	)
	assert.equal(sealedHtml.includes('http-equiv="refresh"'), false)

	double.setInstance({
		status: 'complete',
		output: {
			kind: 'sealed',
			day,
			manifestKey: `daily/full/${day}/manifest.json`,
			alreadySealed: false,
		},
	})
	const fresh = await handleControlPlaneFetch(
		authedGet(`/seal-status?id=${instanceId}`),
		env,
		fetcher,
	)
	assert.equal(fresh.status, 200)
	assert.match(
		await fresh.text(),
		/Sealed day 2026-09-22 at daily\/full\/2026-09-22\/manifest\.json/,
	)

	double.setInstance({
		status: 'errored',
		error: {
			name: 'd1-manifest-missing',
			message: workflowBackupErrorMessage({
				code: 'd1-manifest-missing',
				message: 'Day 2026-09-22 is not ready to seal (d1-manifest-missing).',
			}),
		},
	})
	const incomplete = await handleControlPlaneFetch(
		authedGet(`/seal-status?id=${instanceId}`),
		env,
		fetcher,
	)
	assert.equal(incomplete.status, 409)
	const incompleteHtml = await incomplete.text()
	assert.match(
		incompleteHtml,
		/Day 2026-09-22 is not ready to seal \(d1-manifest-missing\)/,
	)
	assert.match(incompleteHtml, /Seal day incomplete/)

	const retried = await handleControlPlaneFetch(
		authedPost(`day=${day}`),
		env,
		fetcher,
	)
	assert.equal(retried.status, 303)
	assert.equal(double.restartCount(), 1)
	assert.equal(double.created.length, 1)
	assert.equal(sealSpy.mock.calls.length, 0)

	const missing = await handleControlPlaneFetch(
		authedGet('/seal-status'),
		env,
		fetcher,
	)
	assert.equal(missing.status, 400)

	const unknown = await handleControlPlaneFetch(
		authedGet('/seal-status?id=not-a-seal'),
		env,
		fetcher,
	)
	assert.equal(unknown.status, 400)

	const missingDay = await handleControlPlaneFetch(
		new Request('https://backup.example/actions/seal-day', {
			method: 'POST',
			headers: {
				'cf-access-jwt-assertion': jwt,
				'sec-fetch-site': 'same-origin',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: '',
		}),
		env,
		fetcher,
	)
	assert.equal(missingDay.status, 400)
	assert.match(await missingDay.text(), /day is required/)
	assert.equal(double.created.length, 1)

	const csrf = await handleControlPlaneFetch(
		new Request('https://backup.example/actions/seal-day', {
			method: 'POST',
			headers: {
				'cf-access-jwt-assertion': jwt,
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: `day=${day}`,
		}),
		env,
		fetcher,
	)
	assert.equal(csrf.status, 403)
	assert.equal(double.created.length, 1)
	assert.equal(sealSpy.mock.calls.length, 0)
	consoleLog.mockRestore()
	consoleError.mockRestore()
	sealSpy.mockRestore()
})

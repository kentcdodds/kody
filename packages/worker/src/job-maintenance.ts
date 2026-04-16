import { reindexJobVectors } from './jobs/job-reindex.ts'

export async function handleJobReindexRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	const secret = env.CAPABILITY_REINDEX_SECRET?.trim()
	if (!secret) {
		return new Response('Job reindex is not configured', { status: 503 })
	}

	const auth = request.headers.get('Authorization')?.trim()
	const token = auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
	if (token !== secret) {
		return new Response('Unauthorized', { status: 401 })
	}

	try {
		const { upserted } = await reindexJobVectors(env)
		return Response.json({ ok: true, upserted })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return Response.json({ ok: false, error: message }, { status: 500 })
	}
}

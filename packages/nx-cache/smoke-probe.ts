import { mkdir, writeFile } from 'node:fs/promises'

if (process.env.NX_CACHE_SMOKE_FAIL_IF_RUN === '1') {
	console.error('smoke-probe ran; expected a remote Nx cache hit')
	process.exit(1)
}

await mkdir('.tmp', { recursive: true })
await writeFile('.tmp/nx-cache-smoke-probe.txt', 'remote-cache-probe\n')

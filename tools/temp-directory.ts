import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TemporaryDirectory = {
	path: string
	[Symbol.asyncDispose]: () => Promise<void>
}

export async function createTemporaryDirectory(
	prefix: string,
): Promise<TemporaryDirectory> {
	const path = await mkdtemp(join(tmpdir(), prefix))
	return {
		path,
		async [Symbol.asyncDispose]() {
			await rm(path, { recursive: true, force: true })
		},
	}
}

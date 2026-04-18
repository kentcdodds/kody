export type WorkerLoaderModule =
	| string
	| {
			js?: string
			cjs?: string
			text?: string
			data?: ArrayBuffer
			json?: object
	  }

export type WorkerLoaderModules = Record<string, WorkerLoaderModule>

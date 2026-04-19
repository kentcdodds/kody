import type { z } from 'zod'
import type { RepoSessionEdit } from '#worker/repo/types.ts'
import { repoPatchInstructionSchema } from './repo-shared.ts'

type RepoPatchInstruction = z.infer<typeof repoPatchInstructionSchema>

export function toRepoSessionEdit(
	instruction: RepoPatchInstruction,
): RepoSessionEdit {
	switch (instruction.kind) {
		case 'write':
			return instruction
		case 'replace':
			return {
				kind: 'replace' as const,
				path: instruction.path,
				search: instruction.search,
				replacement: instruction.replacement,
				options:
					instruction.options == null
						? undefined
						: {
								caseSensitive: instruction.options.case_sensitive,
								regex: instruction.options.regex,
								wholeWord: instruction.options.whole_word,
								contextBefore: instruction.options.context_before,
								contextAfter: instruction.options.context_after,
								maxMatches: instruction.options.max_matches,
							},
			}
		case 'write_json':
			return {
				kind: 'writeJson' as const,
				path: instruction.path,
				value: instruction.value,
				options:
					instruction.spaces == null
						? undefined
						: { spaces: instruction.spaces },
			}
		default: {
			const exhaustiveCheck: never = instruction
			return exhaustiveCheck
		}
	}
}

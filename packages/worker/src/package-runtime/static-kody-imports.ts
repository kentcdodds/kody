import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
} from './package-import-resolution.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'

export type StaticKodyPackageImport = {
	filePath: string
	specifier: string
	packageName: string
	exportName: string
}

export function isTypeDeclarationFilePath(filePath: string) {
	return /\.d\.[cm]?ts$/.test(filePath)
}

function collectStaticKodyPackageImportsFromSource(input: {
	filePath: string
	source: string
}): Array<StaticKodyPackageImport> {
	const imports: Array<StaticKodyPackageImport> = []
	for (const node of collectLiteralImportNodes(input.source)) {
		if (!node.specifier.startsWith(packageSpecifierPrefix)) continue
		const parsedSpecifier = parseKodyPackageSpecifier(node.specifier)
		imports.push({
			filePath: input.filePath,
			specifier: node.specifier,
			packageName: parsedSpecifier.packageName,
			exportName: parsedSpecifier.exportName,
		})
	}
	return imports
}

export function collectStaticKodyPackageImportsFromFiles(
	files: Record<string, string>,
): Array<StaticKodyPackageImport> {
	return Object.entries(files)
		.filter(([filePath]) => !isTypeDeclarationFilePath(filePath))
		.flatMap(([filePath, source]) =>
			collectStaticKodyPackageImportsFromSource({
				filePath,
				source,
			}),
		)
		.sort(
			(left, right) =>
				left.packageName.localeCompare(right.packageName) ||
				left.exportName.localeCompare(right.exportName) ||
				left.filePath.localeCompare(right.filePath),
		)
}

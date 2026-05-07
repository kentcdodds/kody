export function buildPackageImportSpecifier(
	packageName: string,
	exportName: string,
) {
	if (exportName === '.') {
		return `kody:${packageName}`
	}
	return `kody:${packageName}/${exportName.replace(/^\.\//, '')}`
}

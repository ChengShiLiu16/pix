export function getPixUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pix/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

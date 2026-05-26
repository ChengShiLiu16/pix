/** Listing dirs is lighter than read_many — allow larger batches. */
export const LS_MANY_MAX_PATHS = 20;

export const READ_MANY_MAX_ITEMS = 10;
export const GREP_MANY_MAX_ITEMS = 10;

export function isLsManyArgsRenderable(args: { paths?: string[] }): boolean {
	const paths = args.paths;
	return (
		Array.isArray(paths) &&
		paths.length >= 1 &&
		paths.length <= LS_MANY_MAX_PATHS &&
		paths.every((p) => typeof p === "string" && p.length > 0)
	);
}

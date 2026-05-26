/** Sanitize raw model tool args before schema validation for batch *\_many tools. */

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type GrepManySearchItem = {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
};

export type GrepManyPrepared = {
	searches?: GrepManySearchItem[];
	pattern?: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
};

function isGrepSearchItem(value: unknown): value is GrepManySearchItem {
	return isRecord(value) && typeof value.pattern === "string" && value.pattern.length > 0;
}

/** Drop non-object or pattern-less entries from searches[]; keep top-level single-search shorthand. */
export function prepareGrepManyArguments(args: unknown): GrepManyPrepared {
	if (!isRecord(args)) return args as GrepManyPrepared;

	const prepared: GrepManyPrepared = { ...args } as GrepManyPrepared;

	if (Array.isArray(args.searches)) {
		prepared.searches = args.searches.filter(isGrepSearchItem);
		if (prepared.searches.length === 0) delete prepared.searches;
	}

	return prepared;
}

export type ReadManyFileItem = {
	path: string;
	offset?: number;
	limit?: number;
};

export type ReadManyPrepared = {
	files?: ReadManyFileItem[];
	paths?: string[];
	offset?: number;
	limit?: number;
};

function isReadManyFileItem(value: unknown): value is ReadManyFileItem {
	return isRecord(value) && typeof value.path === "string" && value.path.length > 0;
}

/** Drop non-string entries from paths[] and path-less objects from files[]. */
export function prepareReadManyArguments(args: unknown): ReadManyPrepared {
	if (!isRecord(args)) return args as ReadManyPrepared;

	const prepared: ReadManyPrepared = { ...args } as ReadManyPrepared;

	if (Array.isArray(args.files)) {
		prepared.files = args.files.filter(isReadManyFileItem);
		if (prepared.files.length === 0) delete prepared.files;
	}

	if (Array.isArray(args.paths)) {
		prepared.paths = args.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (prepared.paths.length === 0) delete prepared.paths;
	}

	return prepared;
}

/** @deprecated Use prepareReadManyArguments — kept for ls_many. */
export type PathsPrepared = ReadManyPrepared;

/** @deprecated Use prepareReadManyArguments — kept for ls_many. */
export function preparePathsArguments(args: unknown): PathsPrepared {
	if (!isRecord(args)) return args as PathsPrepared;

	const prepared: PathsPrepared = { ...args } as PathsPrepared;

	if (Array.isArray(args.paths)) {
		prepared.paths = args.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (prepared.paths.length === 0) delete prepared.paths;
	}

	return prepared;
}

declare const process: {
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};

declare const Buffer: {
	byteLength(value: string, encoding?: string): number;
};

declare function require(id: string): unknown;

declare namespace NodeJS {
	interface ErrnoException extends Error {
		code?: string;
	}
}

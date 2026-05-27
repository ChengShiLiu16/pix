declare const process: {
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};

interface BufferConstructor {
	new (str: string, encoding?: BufferEncoding): Buffer<ArrayBuffer>;
	new (size: number): Buffer<ArrayBuffer>;
	new (array: ArrayLike<number>): Buffer<ArrayBuffer>;
	new <TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(arrayBuffer: TArrayBuffer): Buffer<TArrayBuffer>;
	from(array: WithImplicitCoercion<ArrayLike<number>>): Buffer<ArrayBuffer>;
	from<TArrayBuffer extends WithImplicitCoercion<ArrayBufferLike>>(
		arrayBuffer: TArrayBuffer,
		byteOffset?: number,
		length?: number,
	): Buffer<TArrayBuffer>;
	from(string: WithImplicitCoercion<string>, encoding?: BufferEncoding): Buffer<ArrayBuffer>;
	from(arrayOrString: WithImplicitCoercion<ArrayLike<number> | string>): Buffer<ArrayBuffer>;
	of(...items: number[]): Buffer<ArrayBuffer>;
	concat(list: readonly Uint8Array[], totalLength?: number): Buffer<ArrayBuffer>;
	alloc(size: number, fill?: string | Uint8Array | number, encoding?: BufferEncoding): Buffer<ArrayBuffer>;
	allocUnsafe(size: number): Buffer<ArrayBuffer>;
	allocUnsafeSlow(size: number): Buffer<ArrayBuffer>;
	isBuffer(obj: unknown): obj is Buffer<ArrayBuffer>;
	byteLength(string: WithImplicitCoercion<string | ArrayBufferView>, encoding?: BufferEncoding): number;
	compare(buf1: Uint8Array, buf2: Uint8Array): number;
	copyBytesFrom(view: NodeJS.TypedArray, offset?: number, length?: number): Buffer<ArrayBuffer>;
	poolSize: number;
}

type WithImplicitCoercion<T> =
	| T
	| { valueOf(): T }
	| (T extends string ? { [Symbol.toPrimitive](hint: "string"): T } : never);

declare var Buffer: BufferConstructor;

declare function require(id: string): unknown;

declare namespace NodeJS {
	interface ErrnoException extends Error {
		code?: string;
	}
}

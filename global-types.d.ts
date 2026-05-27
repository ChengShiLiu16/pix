/**
 * Global type augmentations for Node.js built-ins.
 *
 * Newer @types/node versions (22+/24+) use a generic Buffer<TArrayBuffer> type
 * and declare the BufferConstructor static methods inside a `declare module "buffer"`
 * augmentation. When the npm `buffer` polyfill package is also installed, TypeScript
 * resolves `module "buffer"` to the polyfill instead of @types/node, which prevents
 * the global augmentation from taking effect. This file bridges the gap by making
 * the Buffer static methods available on the global scope.
 */
interface BufferConstructor {
	new (str: string, encoding?: BufferEncoding): Buffer<ArrayBuffer>;
	new (size: number): Buffer<ArrayBuffer>;
	new (array: ArrayLike<number>): Buffer<ArrayBuffer>;
	new <TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(arrayBuffer: TArrayBuffer): Buffer<TArrayBuffer>;
	from(array: WithImplicitCoercion<ArrayLike<number>>): Buffer<ArrayBuffer>;
	from <TArrayBuffer extends WithImplicitCoercion<ArrayBufferLike>>(
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

declare var Buffer: BufferConstructor;

type WithImplicitCoercion<T> =
	| T
	| { valueOf(): T }
	| (T extends string ? { [Symbol.toPrimitive](hint: "string"): T } : never);

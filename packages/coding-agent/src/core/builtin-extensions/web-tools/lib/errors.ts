export class WebToolsError extends Error {
	readonly userVisible = true;

	constructor(message: string) {
		super(message);
		this.name = "WebToolsError";
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

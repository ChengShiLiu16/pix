import { describe, expect, it } from "vitest";
import { builtin as autoCompactEnhanced } from "../src/core/builtin-extensions/auto-compact-enhanced.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../src/core/extensions/index.ts";

function createMockApi() {
	const handlers: Array<
		(event: SessionBeforeCompactEvent, ctx: ExtensionContext) => SessionBeforeCompactResult | undefined
	> = [];

	const api = {
		on(event: string, handler: unknown) {
			if (event === "session_before_compact" && typeof handler === "function") {
				handlers.push(
					handler as (
						event: SessionBeforeCompactEvent,
						ctx: ExtensionContext,
					) => SessionBeforeCompactResult | undefined,
				);
			}
		},
		registerCommand() {},
	};

	return { api: api as unknown as ExtensionAPI, handlers };
}

function createEvent(reason: SessionBeforeCompactEvent["reason"]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason,
		preparation: {} as SessionBeforeCompactEvent["preparation"],
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

describe("auto compact enhanced", () => {
	it("injects custom instructions only for automatic compaction", async () => {
		const mock = createMockApi();
		autoCompactEnhanced(mock.api);

		const handler = mock.handlers[0]!;
		const ctx = {} as ExtensionContext;

		expect(await handler(createEvent("manual"), ctx)).toBeUndefined();
		expect((await handler(createEvent("threshold"), ctx))?.customInstructions).toContain("保留最近的工作内容");
		expect((await handler(createEvent("overflow"), ctx))?.customInstructions).toContain("文件变更记录");
	});
});

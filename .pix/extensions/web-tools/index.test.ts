import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

const tools: ToolDefinition[] = [];

const pi = {
	registerTool(definition: ToolDefinition) {
		tools.push(definition);
	},
	registerCommand() {
		throw new Error("should not register commands anymore");
	},
	sendUserMessage() {
		throw new Error("should not send user messages anymore");
	},
} as unknown as ExtensionAPI;

extension(pi);

// 验证注册了一个 tool
assert.equal(tools.length, 1);
const tool = tools[0]!;

// 验证 tool 名称和描述
assert.equal(tool.name, "Brave_Search");
assert.equal(tool.label, "Brave Search");
assert.ok(typeof tool.description === "string");
assert.ok(tool.description.length > 0);

// 验证 prompt 配置
assert.equal(tool.promptSnippet, "搜索互联网获取实时信息");
assert.ok(Array.isArray(tool.promptGuidelines));
assert.equal(tool.promptGuidelines!.length, 2);

// 验证参数 schema
const schema = tool.parameters as Record<string, unknown>;
assert.equal(schema.type, "object");
const props = schema.properties as Record<string, unknown>;
assert.ok(props.action);
assert.ok(props.query);
assert.ok(props.url);
assert.ok(props.freshness);
const required = schema.required as string[];
assert.ok(required.includes("action"));

// 验证 renderShell
assert.equal(tool.renderShell, "self");

// 验证 renderCall 存在且可调用
assert.equal(typeof tool.renderCall, "function");
assert.ok(tool.renderResult !== undefined);

// 验证 execute 是可调用的函数
assert.equal(typeof tool.execute, "function");

console.log("web-tools index tests: passed");

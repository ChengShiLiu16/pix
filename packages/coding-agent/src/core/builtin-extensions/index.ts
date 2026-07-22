/**
 * Built-in extensions for Pix.
 *
 * These were previously loaded as external extensions from ~/.pix/agent/extensions/.
 * Now they are compiled directly into the source for tighter integration and
 * faster startup.
 *
 * Extensions that monkey-patched prototypes (markdown-assistant, thinking-steps,
 * editor-input-style, persistent-input-history, user-message-style) have been
 * merged directly into their target source files:
 *   - assistant-message.ts  ← markdown-assistant + thinking-steps rendering
 *   - custom-editor.ts      ← editor-input-style + persistent-input-history
 *   - user-message.ts       ← user-message-style
 *   - tool-execution.ts     ← tool-visibility-patch
 */

import type { InlineExtension } from "../extensions/types.ts";
import { builtin as activityWidget } from "./activity-widget.ts";
import { builtin as askUserQuestion } from "./ask-user-question.ts";
import { builtin as autoCompactEnhanced } from "./auto-compact-enhanced.ts";
import { builtin as compactTools } from "./compact-tools.ts";
import { builtin as diffCommand } from "./diff-command.ts";
import { builtin as fff } from "./fff.ts";
import { builtin as generationWatchdog } from "./generation-watchdog.ts";
import { builtin as gitCheckpoint } from "./git-checkpoint.ts";
import { builtin as grepMany } from "./grep-many.ts";
import { builtin as lsMany } from "./ls-many.ts";
import { builtin as piHealth } from "./pix-health.ts";
import { builtin as promptUrlWidget } from "./prompt-url-widget.ts";
import { builtin as readMany } from "./read-many.ts";
import { builtin as themeColor } from "./theme-color.ts";
import { builtin as todoTracker } from "./todo-tracker.ts";
import { builtin as tps } from "./tps.ts";
import { builtin as webTools } from "./web-tools/index.ts";

/**
 * All built-in extension factories, in load order.
 * Use named InlineExtension wrappers so the startup Extensions list shows
 * `<inline:name>` instead of bare `<inline:N>` sequence numbers.
 * Later extensions can override tools/commands registered by earlier ones.
 */
export const builtinExtensionFactories: InlineExtension[] = [
	{ name: "activity-widget", factory: activityWidget },
	{ name: "compact-tools", factory: compactTools },
	{ name: "todo-tracker", factory: todoTracker },
	{ name: "ask-user-question", factory: askUserQuestion },
	{ name: "auto-compact-enhanced", factory: autoCompactEnhanced },
	{ name: "diff-command", factory: diffCommand },
	{ name: "generation-watchdog", factory: generationWatchdog },
	{ name: "fff", factory: fff },
	{ name: "git-checkpoint", factory: gitCheckpoint },
	{ name: "grep-many", factory: grepMany },
	{ name: "ls-many", factory: lsMany },
	{ name: "pix-health", factory: piHealth },
	{ name: "prompt-url-widget", factory: promptUrlWidget },
	{ name: "read-many", factory: readMany },
	{ name: "theme-color", factory: themeColor },
	{ name: "tps", factory: tps },
	{ name: "web-tools", factory: webTools },
];

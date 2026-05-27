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

import type { ExtensionFactory } from "../extensions/types.ts";
import { builtin as activityWidget } from "./activity-widget.ts";
import { builtin as askUserQuestion } from "./ask-user-question.ts";
import { builtin as autoCompactEnhanced } from "./auto-compact-enhanced.ts";
import { builtin as compactTools } from "./compact-tools.ts";
import { builtin as diffCommand } from "./diff-command.ts";
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
 * Each entry has a name for display in the startup screen.
 * Later extensions can override tools/commands registered by earlier ones.
 */
export const builtinExtensionFactories: (ExtensionFactory & { extensionName?: string })[] = [
	Object.assign(activityWidget, { extensionName: "activity-widget" }),
	Object.assign(compactTools, { extensionName: "compact-tools" }),
	Object.assign(todoTracker, { extensionName: "todo-tracker" }),
	Object.assign(askUserQuestion, { extensionName: "ask-user-question" }),
	Object.assign(autoCompactEnhanced, { extensionName: "auto-compact-enhanced" }),
	Object.assign(diffCommand, { extensionName: "diff-command" }),
	Object.assign(generationWatchdog, { extensionName: "generation-watchdog" }),
	Object.assign(gitCheckpoint, { extensionName: "git-checkpoint" }),
	Object.assign(grepMany, { extensionName: "grep-many" }),
	Object.assign(lsMany, { extensionName: "ls-many" }),
	Object.assign(piHealth, { extensionName: "pix-health" }),
	Object.assign(promptUrlWidget, { extensionName: "prompt-url-widget" }),
	Object.assign(readMany, { extensionName: "read-many" }),

	Object.assign(themeColor, { extensionName: "theme-color" }),
	Object.assign(tps, { extensionName: "tps" }),
	Object.assign(webTools, { extensionName: "web-tools" }),
];

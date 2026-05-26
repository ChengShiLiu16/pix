/**
 * Built-in extensions for Pix.
 *
 * These were previously loaded as external extensions from ~/.pi/agent/extensions/.
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
import { builtin as piHealth } from "./pi-health.ts";
import { builtin as readMany } from "./read-many.ts";
import { builtin as themeColor } from "./theme-color.ts";
import { builtin as todoTracker } from "./todo-tracker.ts";

/**
 * All built-in extension factories, in load order.
 * Later extensions can override tools/commands registered by earlier ones.
 */
export const builtinExtensionFactories: ExtensionFactory[] = [
	activityWidget,
	compactTools,
	todoTracker,
	askUserQuestion,
	autoCompactEnhanced,
	diffCommand,
	generationWatchdog,
	gitCheckpoint,
	grepMany,
	lsMany,
	piHealth,
	readMany,
	themeColor,
];

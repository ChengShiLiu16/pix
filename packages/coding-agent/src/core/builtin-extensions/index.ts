/**
 * Built-in extensions for Pix.
 *
 * These were previously loaded as external extensions from ~/.pi/agent/extensions/.
 * Now they are compiled directly into the source for tighter integration and
 * faster startup.
 */

import type { ExtensionFactory } from "../extensions/types.ts";
import { builtin as activityWidget } from "./activity-widget.ts";
import { builtin as askUserQuestion } from "./ask-user-question.ts";
import { builtin as autoCompactEnhanced } from "./auto-compact-enhanced.ts";
import { builtin as compactTools } from "./compact-tools.ts";
import { builtin as diffCommand } from "./diff-command.ts";
import { builtin as editorInputStyle } from "./editor-input-style.ts";
import { builtin as generationWatchdog } from "./generation-watchdog.ts";
import { builtin as gitCheckpoint } from "./git-checkpoint.ts";
import { builtin as grepMany } from "./grep-many.ts";
import { builtin as lsMany } from "./ls-many.ts";
import { builtin as markdownAssistant } from "./markdown-assistant.ts";
import { builtin as persistentInputHistory } from "./persistent-input-history.ts";
import { builtin as piHealth } from "./pi-health.ts";
import { builtin as readMany } from "./read-many.ts";
import { builtin as themeColor } from "./theme-color.ts";
import { builtin as thinkingSteps } from "./thinking-steps/index.ts";
import { builtin as todoTracker } from "./todo-tracker.ts";
import { builtin as userMessageStyle } from "./user-message-style.ts";

/**
 * All built-in extension factories, in load order.
 * Later extensions can override tools/commands registered by earlier ones.
 */
export const builtinExtensionFactories: ExtensionFactory[] = [
	activityWidget,
	thinkingSteps,
	compactTools,
	todoTracker,
	askUserQuestion,
	autoCompactEnhanced,
	diffCommand,
	editorInputStyle,
	generationWatchdog,
	gitCheckpoint,
	grepMany,
	lsMany,
	markdownAssistant,
	persistentInputHistory,
	piHealth,
	readMany,
	themeColor,
	userMessageStyle,
];

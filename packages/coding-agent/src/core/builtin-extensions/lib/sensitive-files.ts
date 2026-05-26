const SENSITIVE_BASENAMES = new Set([
	".npmrc",
	".pypirc",
	".netrc",
	"auth.json",
	"credentials.json",
	"token.json",
	"tokens.json",
]);

const PRIVATE_KEY_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)$/i;

const SHELL_COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&", "(", ")"]);
const SHELL_REDIRECT_OPERATORS = new Set(["<", ">", ">>", "<<", "<<-", "<<<"]);
const SHELL_INPUT_REDIRECT_OPERATORS = new Set(["<"]);
const SHELL_PREFIX_COMMANDS = new Set(["command", "builtin", "noglob", "sudo", "time"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_PUSH_OPTIONS_WITH_VALUES = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
const GENERIC_FILE_READ_COMMANDS = new Set([
	"base64",
	"cat",
	"head",
	"hexdump",
	"less",
	"more",
	"nl",
	"od",
	"strings",
	"tail",
	"xxd",
]);
const GREP_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);

type ShellCommandSegment = {
	command: string;
	args: string[];
};

export type DangerousShellCommand = {
	command: string;
	reason: string;
};

export function isSensitiveReadPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const basename = normalized.split("/").pop() ?? "";
	const lowerBasename = basename.toLowerCase();
	if (!basename) return false;
	if (lowerBasename.startsWith(".env")) return true;
	if (SENSITIVE_BASENAMES.has(lowerBasename)) return true;
	return PRIVATE_KEY_RE.test(basename);
}

export function sensitiveReadError(filePath: string): string {
	return `Refusing to read sensitive file: ${filePath}`;
}

function flushShellToken(tokens: string[], token: string): string {
	if (token) tokens.push(token);
	return "";
}

function tokenizeShellCommand(command: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		const next = command[index + 1];

		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				token += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			token = flushShellToken(tokens, token);
			continue;
		}

		if (char === "|" || char === "&") {
			token = flushShellToken(tokens, token);
			if (next === char) {
				tokens.push(char + next);
				index++;
			} else {
				tokens.push(char);
			}
			continue;
		}

		if (char === ";" || char === "(" || char === ")") {
			token = flushShellToken(tokens, token);
			tokens.push(char);
			continue;
		}

		if (char === "<") {
			token = flushShellToken(tokens, token);
			if (next === "<") {
				if (command[index + 2] === "<") {
					tokens.push("<<<");
					index += 2;
				} else if (command[index + 2] === "-") {
					tokens.push("<<-");
					index += 2;
				} else {
					tokens.push("<<");
					index++;
				}
			} else {
				tokens.push("<");
			}
			continue;
		}

		if (char === ">") {
			token = flushShellToken(tokens, token);
			if (next === ">") {
				tokens.push(">>");
				index++;
			} else {
				tokens.push(">");
			}
			continue;
		}

		token += char;
	}

	flushShellToken(tokens, token);
	return tokens;
}

function collectHereDocDelimiters(line: string): string[] {
	const tokens = tokenizeShellCommand(line);
	const delimiters: string[] = [];
	for (let index = 0; index < tokens.length - 1; index++) {
		if (tokens[index] === "<<" || tokens[index] === "<<-") {
			delimiters.push(tokens[index + 1]!);
		}
	}
	return delimiters;
}

function stripHereDocBodies(command: string): string {
	const lines = command.split(/\r?\n/);
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		kept.push(line);

		for (const delimiter of collectHereDocDelimiters(line)) {
			index++;
			while (index < lines.length && lines[index]!.trim() !== delimiter) {
				index++;
			}
		}
	}

	return kept.join("\n");
}

function cleanShellPathToken(token: string): string {
	return token.replace(/^[`$({[]+/, "").replace(/[`)}\],;:]+$/, "");
}

function sensitivePathFromToken(token: string): string | undefined {
	const path = cleanShellPathToken(token);
	return path && isSensitiveReadPath(path) ? path : undefined;
}

function shellCommandName(token: string): string {
	return cleanShellPathToken(token).split("/").pop()?.toLowerCase() ?? "";
}

function isShellAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function findShellCommandSegment(tokens: string[]): ShellCommandSegment | undefined {
	let index = 0;
	while (index < tokens.length && isShellAssignment(tokens[index]!)) index++;

	while (index < tokens.length) {
		const command = shellCommandName(tokens[index]!);
		if (!SHELL_PREFIX_COMMANDS.has(command)) break;
		index++;
		while (index < tokens.length && tokens[index]!.startsWith("-")) index++;
		while (index < tokens.length && isShellAssignment(tokens[index]!)) index++;
	}

	const command = shellCommandName(tokens[index] ?? "");
	if (!command) return undefined;
	return { command, args: tokens.slice(index + 1) };
}

function splitShellSegments(tokens: string[]): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];

	for (const token of tokens) {
		if (SHELL_COMMAND_SEPARATORS.has(token)) {
			if (current.length > 0) segments.push(current);
			current = [];
		} else {
			current.push(token);
		}
	}

	if (current.length > 0) segments.push(current);
	return segments;
}

function findSensitiveInputRedirect(tokens: string[]): string | undefined {
	for (let index = 0; index < tokens.length - 1; index++) {
		if (!SHELL_INPUT_REDIRECT_OPERATORS.has(tokens[index]!)) continue;
		const path = sensitivePathFromToken(tokens[index + 1]!);
		if (path) return path;
	}
	return undefined;
}

function skipShellRedirect(tokens: string[], index: number): number {
	if (!SHELL_REDIRECT_OPERATORS.has(tokens[index]!)) return index;
	return index + 1;
}

function findSensitiveGenericReadOperand(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const skipIndex = skipShellRedirect(args, index);
		if (skipIndex !== index) {
			index = skipIndex;
			continue;
		}
		const token = args[index]!;
		if (token === "--") continue;
		if (token.startsWith("-")) continue;
		const path = sensitivePathFromToken(token);
		if (path) return path;
	}
	return undefined;
}

function readOptionValue(option: string, args: string[], index: number, names: readonly string[]): string | undefined {
	for (const name of names) {
		if (option === name) return args[index + 1];
		if (option.startsWith(`${name}=`)) return option.slice(name.length + 1);
		if (name.length === 2 && option.startsWith(name) && option.length > 2) return option.slice(2);
	}
	return undefined;
}

function findSensitiveGrepOperand(args: string[]): string | undefined {
	let hasPattern = false;

	for (let index = 0; index < args.length; index++) {
		const skipIndex = skipShellRedirect(args, index);
		if (skipIndex !== index) {
			index = skipIndex;
			continue;
		}

		const token = args[index]!;
		const fileOption = readOptionValue(token, args, index, ["-f", "--file"]);
		if (fileOption !== undefined) {
			const path = sensitivePathFromToken(fileOption);
			if (path) return path;
			if (fileOption === args[index + 1]) index++;
			continue;
		}

		const patternOption = readOptionValue(token, args, index, [
			"-e",
			"--regexp",
			"-g",
			"--glob",
			"--exclude",
			"--include",
		]);
		if (patternOption !== undefined) {
			hasPattern = true;
			if (patternOption === args[index + 1]) index++;
			continue;
		}

		if (token === "--") continue;
		if (token.startsWith("-")) continue;
		if (!hasPattern) {
			hasPattern = true;
			continue;
		}

		const path = sensitivePathFromToken(token);
		if (path) return path;
	}

	return undefined;
}

function findSensitiveSedOperand(args: string[]): string | undefined {
	let hasScript = false;

	for (let index = 0; index < args.length; index++) {
		const skipIndex = skipShellRedirect(args, index);
		if (skipIndex !== index) {
			index = skipIndex;
			continue;
		}

		const token = args[index]!;
		const scriptFile = readOptionValue(token, args, index, ["-f", "--file"]);
		if (scriptFile !== undefined) {
			const path = sensitivePathFromToken(scriptFile);
			if (path) return path;
			hasScript = true;
			if (scriptFile === args[index + 1]) index++;
			continue;
		}

		const inlineScript = readOptionValue(token, args, index, ["-e", "--expression"]);
		if (inlineScript !== undefined) {
			hasScript = true;
			if (inlineScript === args[index + 1]) index++;
			continue;
		}

		if (token === "--") continue;
		if (token.startsWith("-")) continue;
		if (!hasScript) {
			hasScript = true;
			continue;
		}

		const path = sensitivePathFromToken(token);
		if (path) return path;
	}

	return undefined;
}

function findSensitiveAwkOperand(args: string[]): string | undefined {
	let hasProgram = false;

	for (let index = 0; index < args.length; index++) {
		const skipIndex = skipShellRedirect(args, index);
		if (skipIndex !== index) {
			index = skipIndex;
			continue;
		}

		const token = args[index]!;
		const programFile = readOptionValue(token, args, index, ["-f"]);
		if (programFile !== undefined) {
			const path = sensitivePathFromToken(programFile);
			if (path) return path;
			hasProgram = true;
			if (programFile === args[index + 1]) index++;
			continue;
		}

		if (token === "--") continue;
		if (token.startsWith("-")) continue;
		if (!hasProgram) {
			hasProgram = true;
			continue;
		}
		if (isShellAssignment(token)) continue;

		const path = sensitivePathFromToken(token);
		if (path) return path;
	}

	return undefined;
}

function findSensitiveSourceOperand(args: string[]): string | undefined {
	for (const token of args) {
		if (token === "--") continue;
		if (token.startsWith("-")) continue;
		return sensitivePathFromToken(token);
	}
	return undefined;
}

function findSensitiveShellSegmentRead(segment: ShellCommandSegment): string | undefined {
	if (GENERIC_FILE_READ_COMMANDS.has(segment.command)) return findSensitiveGenericReadOperand(segment.args);
	if (GREP_COMMANDS.has(segment.command)) return findSensitiveGrepOperand(segment.args);
	if (segment.command === "sed") return findSensitiveSedOperand(segment.args);
	if (segment.command === "awk") return findSensitiveAwkOperand(segment.args);
	if (segment.command === "source" || segment.command === ".") return findSensitiveSourceOperand(segment.args);
	return undefined;
}

function gitSubcommandIndex(args: string[]): number {
	for (let index = 0; index < args.length; index++) {
		const token = args[index]!;
		if (token === "--") return index + 1;
		if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
			index++;
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) continue;
		if (token.startsWith("-c") && token.length > 2) continue;
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("--namespace="))
			continue;
		if (token.startsWith("-")) continue;
		return index;
	}
	return -1;
}

function isGitPushForceFlag(token: string): boolean {
	if (token === "--force") return true;
	if (token.startsWith("--force=")) return token.slice("--force=".length) !== "false";
	if (token.startsWith("--")) return false;
	return /^-[A-Za-z]*f[A-Za-z]*$/.test(token);
}

function gitPushOptionTakesValue(token: string): boolean {
	return GIT_PUSH_OPTIONS_WITH_VALUES.has(token);
}

function findDangerousGitPush(args: string[]): DangerousShellCommand | undefined {
	let optionsEnded = false;
	for (let index = 0; index < args.length; index++) {
		const token = args[index]!;
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && isGitPushForceFlag(token)) {
			return {
				command: `git push ${token}`,
				reason:
					"Bare force pushes can overwrite remote branch history. Ask the user first; if explicitly approved, prefer --force-with-lease.",
			};
		}
		if (!optionsEnded && gitPushOptionTakesValue(token)) {
			index++;
			continue;
		}
		if (!optionsEnded && token.startsWith("-")) continue;
		if (token.startsWith("+") && token.length > 1) {
			return {
				command: `git push ${token}`,
				reason:
					"Force refspecs can overwrite remote branch history. Ask the user first; if explicitly approved, prefer --force-with-lease.",
			};
		}
	}
	return undefined;
}

function findDangerousShellSegmentCommand(segment: ShellCommandSegment): DangerousShellCommand | undefined {
	if (segment.command !== "git") return undefined;
	const subcommandIndex = gitSubcommandIndex(segment.args);
	if (subcommandIndex < 0) return undefined;
	const subcommand = segment.args[subcommandIndex]?.toLowerCase();
	if (subcommand !== "push") return undefined;
	return findDangerousGitPush(segment.args.slice(subcommandIndex + 1));
}

function findShellEvalScript(segment: ShellCommandSegment): string | undefined {
	if (segment.command !== "bash" && segment.command !== "sh" && segment.command !== "zsh") return undefined;
	for (let index = 0; index < segment.args.length - 1; index++) {
		const token = segment.args[index]!;
		if (token === "-c") return segment.args[index + 1];
		if (token.startsWith("-") && token.includes("c")) return segment.args[index + 1];
	}
	return undefined;
}

export function findSensitiveShellReadPath(command: string, depth = 0): string | undefined {
	if (!command || depth > 2) return undefined;

	const tokens = tokenizeShellCommand(stripHereDocBodies(command));
	const redirectedPath = findSensitiveInputRedirect(tokens);
	if (redirectedPath) return redirectedPath;

	for (const tokensInSegment of splitShellSegments(tokens)) {
		const segment = findShellCommandSegment(tokensInSegment);
		if (!segment) continue;

		const script = findShellEvalScript(segment);
		if (script) {
			const path = findSensitiveShellReadPath(script, depth + 1);
			if (path) return path;
		}

		const path = findSensitiveShellSegmentRead(segment);
		if (path) return path;
	}

	return undefined;
}

export function findDangerousShellCommand(command: string, depth = 0): DangerousShellCommand | undefined {
	if (!command || depth > 2) return undefined;

	const tokens = tokenizeShellCommand(stripHereDocBodies(command));
	for (const tokensInSegment of splitShellSegments(tokens)) {
		const segment = findShellCommandSegment(tokensInSegment);
		if (!segment) continue;

		const script = findShellEvalScript(segment);
		if (script) {
			const nested = findDangerousShellCommand(script, depth + 1);
			if (nested) return nested;
		}

		const dangerous = findDangerousShellSegmentCommand(segment);
		if (dangerous) return dangerous;
	}

	return undefined;
}

export function dangerousShellCommandError(dangerous: DangerousShellCommand): string {
	return `Refusing dangerous shell command: ${dangerous.command}. ${dangerous.reason}`;
}

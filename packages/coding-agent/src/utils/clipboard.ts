import { execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

const CLIPBOARD_TIMEOUT_MS = 5000;

// Write `text` to a clipboard helper's stdin without blocking the event loop.
// execSync runs synchronously and can hang for clipboard helpers (e.g. wl-copy's
// fork/daemonize behavior, or pbcopy under a raw-mode TUI), which freezes the
// render loop. Always spawn asynchronously and bound it with a timeout so a
// wedged helper can never lock up the UI.
function spawnClipboardWrite(command: string, args: string[], text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`${command} timed out`));
		}, CLIPBOARD_TIMEOUT_MS);
		const settle = (err?: Error) => {
			clearTimeout(timer);
			if (err) reject(err);
			else resolve();
		};
		proc.on("error", (err) => settle(err));
		proc.on("close", (code) => settle(code === 0 ? undefined : new Error(`${command} exited with code ${code}`)));
		proc.stdin.on("error", () => {
			// Ignore EPIPE if the helper exits before we finish writing.
		});
		proc.stdin.write(text);
		proc.stdin.end();
	});
}

async function copyViaX11Clipboard(text: string): Promise<void> {
	try {
		await spawnClipboardWrite("xclip", ["-selection", "clipboard"], text);
	} catch {
		await spawnClipboardWrite("xsel", ["--clipboard", "--input"], text);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	if (!copied) {
		try {
			if (p === "darwin") {
				await spawnClipboardWrite("pbcopy", [], text);
				copied = true;
			} else if (p === "win32") {
				await spawnClipboardWrite("clip", [], text);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					try {
						await spawnClipboardWrite("termux-clipboard-set", [], text);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// Verify wl-copy exists first (spawn ENOENT is async and easy to miss).
							execSync("which wl-copy", { stdio: "ignore" });
							await spawnClipboardWrite("wl-copy", [], text);
							copied = true;
						} catch {
							if (hasX11Display) {
								await copyViaX11Clipboard(text);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						await copyViaX11Clipboard(text);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}

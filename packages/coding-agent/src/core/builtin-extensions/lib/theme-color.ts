export type ThemeColorResult = {
	hex: string;
	label: string;
};

export type ThemeFile = {
	name?: unknown;
	vars?: Record<string, unknown>;
	colors?: Record<string, unknown>;
	[key: string]: unknown;
};

export const NAMED_THEME_COLORS: Record<string, string> = {
	amber: "#f59e0b",
	blue: "#3b82f6",
	cyan: "#06b6d4",
	green: "#22c55e",
	indigo: "#6366f1",
	orange: "#ff9f43",
	pink: "#ec4899",
	purple: "#8b5cf6",
	red: "#ef4444",
	teal: "#14b8a6",
	yellow: "#eab308",
};

const THEME_COLOR_SLOTS: Record<string, string> = {
	accent: "userAccent",
	borderAccent: "userAccentBright",
	warning: "userAccentCode",
	toolTitle: "userAccentBright",
	toolOutput: "userAccentSoft",
	mdHeading: "userAccentBright",
	mdLink: "userAccent",
	mdLinkUrl: "dimGray",
	mdCode: "userAccentCode",
	mdCodeBlock: "",
	mdCodeBlockBorder: "darkGray",
	mdQuote: "gray",
	mdQuoteBorder: "darkGray",
	mdHr: "darkGray",
	mdListBullet: "userAccent",
	thinkingLow: "userAccentDim",
	thinkingMedium: "userAccentSoft",
	thinkingHigh: "userAccent",
	thinkingXhigh: "userAccentBright",
	bashMode: "userAccentSoft",
};

function expandHex(input: string): string | undefined {
	const normalized = input.trim().toLowerCase();
	const named = NAMED_THEME_COLORS[normalized];
	if (named) return named;

	const hex = normalized.startsWith("#") ? normalized : `#${normalized}`;
	const short = hex.match(/^#([0-9a-f]{3})$/i);
	if (short) {
		const [r, g, b] = short[1]!.split("");
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}

	return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : undefined;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function channelToHex(value: number): string {
	return Math.round(value).toString(16).padStart(2, "0");
}

function rgbToHex(color: { r: number; g: number; b: number }): string {
	return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
}

function mixHex(left: string, right: string, ratio: number): string {
	const a = hexToRgb(left);
	const b = hexToRgb(right);
	return rgbToHex({
		r: a.r + (b.r - a.r) * ratio,
		g: a.g + (b.g - a.g) * ratio,
		b: a.b + (b.b - a.b) * ratio,
	});
}

export function parseThemeColor(input: string): ThemeColorResult | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;

	const first = trimmed.split(/\s+/, 1)[0] ?? "";
	const hex = expandHex(first);
	if (!hex) return undefined;

	return {
		hex,
		label: NAMED_THEME_COLORS[first.toLowerCase()] ? first.toLowerCase() : hex,
	};
}

export function createAccentPalette(hex: string): Record<string, string> {
	return {
		accent: hex,
		userAccent: hex,
		userAccentBright: mixHex(hex, "#ffffff", 0.24),
		userAccentSoft: mixHex(hex, "#ffffff", 0.4),
		userAccentDim: mixHex(hex, "#000000", 0.46),
		userAccentCode: mixHex(hex, "#ffffff", 0.55),
		// Keep existing orange variable names working for older theme references.
		orange: hex,
		orangeBright: mixHex(hex, "#ffffff", 0.24),
		orangeSoft: mixHex(hex, "#ffffff", 0.4),
		orangeDim: mixHex(hex, "#000000", 0.46),
		amber: mixHex(hex, "#ffffff", 0.55),
	};
}

export function applyThemeAccentColor(theme: ThemeFile, input: string): { theme: ThemeFile; color: ThemeColorResult } {
	const color = parseThemeColor(input);
	if (!color) {
		throw new Error(`Invalid theme color: ${input || "(empty)"}`);
	}

	const next: ThemeFile = {
		...theme,
		vars: { ...(theme.vars ?? {}) },
		colors: { ...(theme.colors ?? {}) },
	};

	Object.assign(next.vars!, createAccentPalette(color.hex));
	Object.assign(next.colors!, THEME_COLOR_SLOTS);

	return { theme: next, color };
}

export function themeColorUsage(): string {
	return `Usage: /theme-color <${Object.keys(NAMED_THEME_COLORS).join("|")}|#rrggbb>`;
}

export function themeColorCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	const normalized = prefix.trim().toLowerCase();
	const matches = Object.keys(NAMED_THEME_COLORS)
		.filter((name) => name.startsWith(normalized))
		.map((name) => ({ value: name, label: name }));
	return matches.length > 0 ? matches : null;
}

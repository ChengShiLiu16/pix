import * as fs from "node:fs";
import { Container, Image, Spacer, Text } from "@chengshiliu16/pix-tui";
import { getBundledInteractiveAssetPath } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const PROJECT_URL = "https://github.com/ChengShiLiu16/pix";
const IMAGE_FILENAME = "clankolas.png";

let cachedImageBase64: string | undefined;
let attemptedImageLoad = false;

function loadImageBase64(): string | undefined {
	if (attemptedImageLoad) {
		return cachedImageBase64;
	}

	attemptedImageLoad = true;
	try {
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
	} catch {
		cachedImageBase64 = undefined;
	}
	return cachedImageBase64;
}

export class ProjectAnnouncementComponent extends Container {
	constructor() {
		super();

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Pix coding agent")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Project home:"), 1, 0));
		this.addChild(new Text(theme.fg("mdLink", PROJECT_URL), 1, 0));
		this.addChild(new Spacer(1));

		const imageBase64 = loadImageBase64();
		if (imageBase64) {
			this.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			this.addChild(new Spacer(1));
		}

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}

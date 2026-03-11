import { dts } from "bun-plugin-dtsx";
import { generateEntities } from "./generate-entities.ts";

const virtualEntities = await generateEntities();

await Bun.$`rm -rf dist`;

const result = await Bun.build({
	entrypoints: ["src/main.ts"],
	metafile: "meta.json",
	plugins: [dts()],
	target: "browser",
	footer: "// Built with red eyes by ACY in Florida",
	minify: true,
	outdir: "dist",
	files: {
		"./entities.js": virtualEntities,
	},
});

if (result.metafile) {
	for (const [path, meta] of Object.entries(result.metafile.outputs)) {
		const megabytes = meta.bytes / 1_000_000;
		Bun.stdout.write(`${path}: ${megabytes} mb`);
	}
}

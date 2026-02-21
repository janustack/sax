import { dts } from "bun-plugin-dtsx";
import { generateEntities } from "./scripts/gen-entities.ts";

const virtualEntities = await generateEntities();

await Bun.$`rm -rf dist`;

await Bun.$`zig build`;

const result = await Bun.build({
	entrypoints: ["src/ts/main.ts"],
	metafile: "meta.json",
	plugins: [dts()],
	target: "browser",
	footer: "// Built with love by ACY in Florida",
	minify: true,
	outdir: "dist",
	root: "src/ts",
	files: {
		"./entities.js": virtualEntities,
	},
});

await Bun.$`cp src/wasm/lib.wasm dist/`;

if (result.metafile) {
	for (const [path, meta] of Object.entries(result.metafile.outputs)) {
		const megabytes = meta.bytes / 1_000_000;
		Bun.stdout.write(`${path}: ${megabytes} mb`);
	}
}

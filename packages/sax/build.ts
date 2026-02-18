import { dts } from "bun-plugin-dtsx";

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
});

await Bun.$`cp src/wasm/utils.wasm dist/`;

if (result.metafile) {
	// Analyze outputs
	for (const [path, meta] of Object.entries(result.metafile.outputs)) {
		console.log(`${path}: ${meta.bytes} bytes`);
	}
}

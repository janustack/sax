import { dts } from "bun-plugin-dtsx";

const footerMessage = "// Built with love by ACY in Florida";

const baseConfig = {
	footer: footerMessage,
	minify: true,
	outdir: "dist",
};

await Bun.$`rm -rf dist`;

await Bun.build({
	...baseConfig,
	entrypoints: ["src/main.ts"],
	plugins: [dts()],
	target: "browser",
});

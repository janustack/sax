import JanustackSAX, { type SAXOptions, wasmURL } from "@janustack/sax";
import { bench, group, run } from "mitata";
import IsaacsSAX from "sax";

const baseOptions = {
	lowercase: true,
	normalize: true,
	strict: true,
	trim: true,
};

const janustackOptions: SAXOptions = {
	...baseOptions,
	namespaces: true,
	trackPosition: true,
};

const isaacsOptions = {
	...baseOptions,
	position: true,
	xmlns: true,
};

const path = "../assets/icon.svg";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

// const bytes = await Bun.file(wasmURL).bytes();

group("XML Parser Comparison (text)", () => {
	bench("Isaacs SAX", () => {
		const parser = IsaacsSAX.parser(isaacsOptions.strict, isaacsOptions);
		parser.write(text);
		parser.close();
	});

	bench("Janustack SAX", async () => {
		const parser = new JanustackSAX.Parser(janustackOptions);
		// await parser.initWasm(bytes);
		parser.write(text);
		parser.end();
	});
});

await run();

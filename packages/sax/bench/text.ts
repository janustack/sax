import JanustackSAX, { type SAXOptions, wasmURL } from "@janustack/sax";
import { bench, group, run } from "mitata";
import IsaacsSAX from "sax";

const janustackOptions: SAXOptions = {
	namespaces: true,
	nameCasing: "lowercase",
	normalize: true,
	trackPosition: true,
	trim: true,
	strict: true,
} as const;

const isaacsOptions = {
	lowercase: true,
	normalize: true,
	position: true,
	strict: true,
	trim: true,
	xmlns: true,
} as const;

const bytes = await Bun.file(wasmURL).bytes();

const path = "../assets/large.xml";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

const parser = new JanustackSAX.Parser(janustackOptions);
await parser.loadWasm(bytes);

group("XML Parser Comparison (text)", () => {
	bench("Janustack SAX", async () => {
		parser.write(text);
		parser.end();
	});

	bench("Isaacs SAX", () => {
		const parser = IsaacsSAX.parser(isaacsOptions.strict, isaacsOptions);
		parser.write(text);
		parser.close();
	});
});

await run();

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

const decoder = new TextDecoder();

const path = "../assets/large.xml";
const url = new URL(path, import.meta.url);
const bytes = await Bun.file(wasmURL).bytes();

group("XML Parser Comparison (streaming)", () => {
	bench("Isaacs SAX", async () => {
		const stream = Bun.file(url).stream();
		const parser = IsaacsSAX.parser(isaacsOptions.strict, isaacsOptions);
		for await (const chunk of stream) {
			parser.write(decoder.decode(chunk, { stream: true }));
		}
		parser.close();
	});

	bench("Janustack SAX", async () => {
		const stream = Bun.file(url).stream();
		const parser = new JanustackSAX.Parser(janustackOptions);
		// await parser.initWasm(bytes);
		for await (const chunk of stream) {
			parser.write(chunk);
		}
		parser.end();
	});
});

await run();

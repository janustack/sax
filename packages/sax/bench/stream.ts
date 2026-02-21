import JanustackSAX, { type SAXOptions, wasmURL } from "@janustack/sax";
import { bench, group, run } from "mitata";
import IsaacsSAX from "sax";

const janustackOptions: SAXOptions = {
	caseTransform: "lowercase",
	namespaces: true,
	normalize: true,
	strict: true,
	trackPosition: true,
	trim: true,
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
const wasmModule = await WebAssembly.compile(bytes);

const path = "../assets/large.xml";
const url = new URL(path, import.meta.url);

const parser = new JanustackSAX.Parser(janustackOptions);
await parser.loadWasm(bytes);

const decoder = new TextDecoder();

group("XML Parser Comparison (streaming)", () => {
	bench("Janustack SAX", async () => {
		const parser = new JanustackSAX.Parser(janustackOptions);
		await parser.loadWasm(wasmModule);
		const stream = Bun.file(url).stream();
		for await (const chunk of stream) {
			parser.write(chunk);
		}
		parser.end();
	});

	bench("Isaacs SAX", async () => {
		const parser = IsaacsSAX.parser(isaacsOptions.strict, isaacsOptions);
		const stream = Bun.file(url).stream();
		for await (const chunk of stream) {
			parser.write(decoder.decode(chunk, { stream: true }));
		}
		parser.close();
	});
});

await run();

import { type SAXOptions, SAXParser } from "@janustack/sax";
import { bench, group, run } from "mitata";

const janustackOptions: SAXOptions = {
	caseTransform: "lowercase",
	namespaces: true,
	strict: true,
	trackPosition: true,
} as const;

const path = "../assets/index.jsx";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

group("XML Parser Comparison (streaming)", () => {
	bench("Janustack SAX", async () => {
		const parser = new SAXParser(janustackOptions);
		const stream = Bun.file(url).stream();
		for await (const chunk of stream) {
			parser.write(chunk);
		}
		parser.end();
	});
});

group("XML Parser Comparison (text)", () => {
	bench("Janustack SAX", () => {
		const parser = new SAXParser(janustackOptions);
		parser.write(text);
		parser.end();
	});
});

await run();

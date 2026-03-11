import { type SAXOptions, SAXParser } from "@janustack/sax";
import { bench, group, run } from "mitata";

const janustackOptions: SAXOptions = {
	namespaces: false,
	strict: false,
	trackPosition: false,
} as const;

const path = "../assets/index.xml";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

group("XML Parser Comparison", () => {
	bench("Janustack SAX  (streaming)", async () => {
		const parser = new SAXParser(janustackOptions);
		const stream = Bun.file(url).stream();
		for await (const chunk of stream) {
			parser.write(chunk);
		}
		parser.end();
	});

	bench("Janustack SAX (text)", () => {
		const parser = new SAXParser(janustackOptions);
		parser.write(text);
		parser.end();
	});
});

await run();

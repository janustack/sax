import { Parser, type SAXHandlers, type SAXOptions } from "@janustack/sax";

const options: SAXOptions = {
	lowercase: true,
	normalize: false,
	position: true,
	strict: true,
	trim: false,
	xmlns: true,
};

const handlers: SAXHandlers = {
	onProcessingInstruction(data) {
		console.log("Processing Instruction:", data);
	},
	onComment(comment) {
		console.log("COMMENT:", comment);
	},
	onCdata(cdata) {
		console.log("CDATA:", cdata);
	},
	onOpenTag(tag) {
		console.log("OPEN:", tag.name, tag);
	},
	onAttribute(attribute) {
		console.log("Attribute:", attribute);
	},
	onText(text) {
		if (text.trim()) {
			console.log("TEXT:", text);
		}
	},
	onCloseTag(name) {
		console.log("CLOSE:", name);
	},
	onError(error) {
		console.error("ERROR:", error);
	},
};

const wasmPath = import.meta.resolve("../dist/utils.wasm");
const wasmBytes = new Uint8Array(
	await Bun.file(Bun.fileURLToPath(wasmPath)).arrayBuffer(),
);

const parser = new Parser(options, handlers);
await parser.initWasm(wasmBytes);

const xmlPath = "./assets/large.xml";
const xmlURL = new URL(xmlPath, import.meta.url);
const xmlFile = Bun.file(xmlURL);

const startTime = Bun.nanoseconds();

const stream = xmlFile.stream().pipeThrough(new TextDecoderStream());

for await (const chunk of stream) {
	parser.write(chunk);
}

parser.end();

const endTime = Bun.nanoseconds();

const duration = (endTime - startTime) / 1_000_000;

Bun.stdout.write(
	`\n---SAX Benchmark Report---\nTime: ${duration.toFixed(2)} ms\n`,
);

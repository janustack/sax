import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import SAX, {
	type SAXHandlers,
	type SAXOptions,
	wasmURL,
} from "@janustack/sax";

const options: SAXOptions = {
	caseTransform: "lowercase",
	namespaces: true,
	normalize: true,
	strict: true,
	trackPosition: true,
	trim: true,
} as const;

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

const bytes = await readFile(wasmURL);

const path = "../../assets/large.xml";
const url = new URL(path, import.meta.url);
const stream = createReadStream(url);

const parser = new SAX.Parser(options, handlers);
await parser.loadWasm(bytes);

for await (const chunk of stream) {
	parser.write(chunk);
}

parser.end();

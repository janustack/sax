import SAX, {
	type SAXHandlers,
	type SAXOptions,
	wasmURL,
} from "@janustack/sax";
import { readFile } from "node:fs/promises";

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
		console.log("Comment:", comment);
	},
	onCdata(cdata) {
		console.log("C Data:", cdata);
	},
	onOpenTag(tag) {
		console.log("Open:", tag.name, tag);
	},
	onAttribute(attribute) {
		console.log("Attribute:", attribute);
	},
	onText(text) {
		if (text.trim()) {
			console.log("Text:", text);
		}
	},
	onCloseTag(name) {
		console.log("Close:", name);
	},
	onError(error) {
		console.error("Error:", error);
	},
};

const bytes = await readFile(wasmURL);

const path = "../../assets/icon.svg";
const url = new URL(path, import.meta.url);
const xml = await Bun.file(url).text();

const parser = new SAX.Parser(options, handlers);
await parser.loadWasm(bytes);

parser.write(xml);
parser.end();

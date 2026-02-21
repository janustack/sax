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

const path = "../../assets/large.xml";
const url = new URL(path, import.meta.url);
const response = await fetch(url);

const parser = new SAX.Parser(options, handlers);
await parser.loadWasm(response);

parser.write(xml);
parser.end();

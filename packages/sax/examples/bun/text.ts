import SAX, {
	type SAXHandlers,
	type SAXOptions,
	wasmURL,
} from "@janustack/sax";

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

const options: SAXOptions = {
	caseTransform: "lowercase",
	namespaces: true,
	normalize: true,
	strict: true,
	trackPosition: true,
	trim: true,
} as const;

async function 1() {
    // Parses the XML data from a readable stream.
    const bytes = await Bun.file(wasmURL).bytes();
    const parser = new SAX.Parser(options);
    if (await parser.loadWasm(bytes)) {
        const url = new URL("../../assets/icon.svg", import.meta.url);
        const stream = Bun.file(url).stream();
        for await (const [event, detail] of parser.parse(stream.getReader())) {
            // handle events
        }
    }
}

async function parseXMLWithManualWrite() {
    // Writes a chunk of data to the parser.
    const bytes = await Bun.file(wasmURL).bytes();
    const parser = new SAX.Parser(options, handlers);
    if (await parser.loadWasm(bytes)) {
        const url = new URL("../../assets/icon.svg", import.meta.url);
        const stream = Bun.file(url).stream();
        for await (const chunk of stream) {
            parser.write(chunk);
        }
        parser.end();
    }
}

async function parseXMLStreamAndLogJSONEvents() {
  const bytes = await Bun.file(wasmURL).bytes();
  const parser = new SAX.Parser(options);
  if (await parser.loadWasm(bytes)) {
      const url = new URL("../../assets/icon.svg", import.meta.url);
      const stream = Bun.file(url).stream();
      for await (const [event, detail] of parser.parse(stream.getReader())) {
          console.log(JSON.stringify([event, detail.toJSON()]))
      }
  }
}

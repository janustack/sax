import SAX from "sax";

const options = {
	lowercase: false,
	normalize: false,
	position: false,
	strict: false,
	trim: false,
	xmlns: false,
} as const;

const parser = SAX.parser(options.strict, options);

parser.onattribute = (attribute) => {
	console.log("Attribute:", attribute);
};
parser.oncdata = (cdata) => {
	console.log("Cdata:", cdata);
};
parser.onclosetag = (name) => {
	console.log("Close Tag:", name);
};
parser.oncomment = (comment) => {
	console.log("Comment:", comment);
};
parser.onerror = (error) => {
	console.error("Error:", error);
};
parser.onopentag = (tag) => {
	console.log("Open Tag:", tag);
};
parser.onprocessinginstruction = (data) => {
	console.log("Processing Instruction:", data);
};
parser.ontext = (text) => {
	if (text.trim()) {
		console.log("Text:", text);
	}
};

const decoder = new TextDecoder();

const path = "../../assets/index.html";
const url = new URL(path, import.meta.url);
const stream = Bun.file(url).stream();

for await (const chunk of stream) {
	parser.write(decoder.decode(chunk, { stream: true }));
}

parser.close();

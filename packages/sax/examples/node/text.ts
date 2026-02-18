import SAX from "sax";

const options = {
	lowercase: true,
	normalize: false,
	position: true,
	strict: true,
	trim: false,
	xmlns: true,
} as const;

const parser = SAX.parser(options.strict, options);

parser.onprocessinginstruction = (data) => {
	console.log("Processing Instruction:", data);
};

parser.oncomment = (comment) => {
	console.log("COMMENT:", comment);
};

parser.oncdata = (cdata) => {
	console.log("CDATA:", cdata);
};

parser.onopentag = (tag) => {
	console.log("OPEN:", tag.name, tag);
};

parser.onattribute = (attribute) => {
	console.log("Attribute:", attribute);
};

parser.ontext = (text) => {
	if (text.trim()) {
		console.log("TEXT:", text);
	}
};

parser.onclosetag = (name) => {
	console.log("CLOSE:", name);
};

parser.onerror = (error) => {
	console.error("ERROR:", error);
};

const path = "../assets/small.xml";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

const startTime = Bun.nanoseconds();

parser.write(text);
parser.end();

const endTime = Bun.nanoseconds();

const duration = (endTime - startTime) / 1_000_000;

Bun.stdout.write(
	`\n---SAX Benchmark Report---\nTime: ${duration.toFixed(2)} ms\n`,
);

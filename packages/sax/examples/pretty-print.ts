import fs from "node:fs";
import path from "node:path";
import sax from "@janustack/sax";

// 1. FIX: Move argument validation to the very top, before using argv[2]
if (!process.argv[2]) {
	throw new Error(
		"Please provide an xml file to prettify\n" +
			"Usage: bun run pretty-print.ts <file.xml>",
	);
}

const printer = sax.streamer(false, { lowercaseTags: true, trim: true });
const xmlfile = path.join(process.cwd(), process.argv[2]);
const fileStream = fs.createReadStream(xmlfile, { encoding: "utf8" });

function entity(input: string): string {
	return input.replaceAll('"', "&quot;");
}

function print(char: string): void {
	if (!process.stdout.write(char)) {
		fileStream.pause();
	}
}

// 2. FIX: Use a standard function so 'this' binds to the printer
function onText(text: string): void {
	this.indent();
	print(text);
}

printer.tabstop = 2;
printer.level = 0;

// 3. FIX: Convert arrow function to standard function for 'this' access
printer.indent = function (this: any) {
	print("\n");
	for (let i = this.level; i > 0; i--) {
		for (let j = this.tabstop; j > 0; j--) {
			print(" ");
		}
	}
};

// 4. FIX: Convert all event handlers to standard functions
printer.on("opentag", function (tag: any) {
	this.indent();
	this.level++;
	print(`<${tag.name}`);
	for (const i in tag.attributes) {
		print(` ${i}="${entity(tag.attributes[i])}"`);
	}
	print(">");
});

printer.on("text", onText);
printer.on("doctype", onText);

printer.on("closetag", function (tag: string) {
	this.level--;
	this.indent();
	print(`</${tag}>`);
});

printer.on("cdata", function (data: string) {
	this.indent();
	print(`<![CDATA[${data}]]>`);
});

printer.on("comment", function (comment: string) {
	this.indent();
	print(`<!--${comment}-->`);
});

printer.on("error", (error: Error) => {
	console.error(error);
	throw error;
});

process.stdout.on("drain", () => {
	fileStream.resume();
});

fileStream.pipe(printer);

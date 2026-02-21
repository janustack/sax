import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { SaxEventType, SAXParser } from 'sax-wasm';

const mask =
    SaxEventType.OpenTag |
    SaxEventType.CloseTag |
    SaxEventType.Text |
    SaxEventType.Comment |
    SaxEventType.Cdata |
    SaxEventType.ProcessingInstruction |
    SaxEventType.Doctype |
    SaxEventType.Attribute;

const url = new URL('../node_modules/sax-wasm/lib/sax-wasm.wasm', import.meta.url);
const bytes = await Bun.file(url).bytes();

const parser = new SAXParser(mask);
await parser.prepareWasm(bytes);

const xmlUrl = new URL('../assets/small.xml', import.meta.url);
const webStream = Readable.toWeb(createReadStream(xmlUrl));

for await (const [event, detail] of parser.parse(webStream.getReader())) {
  switch (event) {
    case SaxEventType.OpenTag: {
			// Typically: { name, attributes, isSelfClosing, prefix?, local?, uri? }
			console.log("openTag:", detail);
			break;
		}

		case SaxEventType.Attribute: {
			// Typically: { name, value, prefix?, local?, uri? }
			console.log("attribute:", detail);
			break;
		}

		case SaxEventType.CloseTag: {
			// Typically: { name } or name string (depends on sax-wasm version)
			console.log("closeTag:", detail);
			break;
		}

		case SaxEventType.Text: {
			// Typically: string
			const text = typeof detail === "string" ? detail : String(detail);
			// Ignore pure-whitespace text nodes if desired:
			if (text.trim().length !== 0) console.log("text:", JSON.stringify(text));
			break;
		}

		case SaxEventType.Comment: {
			// Typically: string
			console.log("comment:", detail);
			break;
		}

		case SaxEventType.Cdata: {
			// Typically: string (some builds may separate open/close cdata)
			console.log("cdata:", detail);
			break;
		}

		case SaxEventType.ProcessingInstruction: {
			// Typically: { target, body } or similar
			console.log("pi:", detail);
			break;
		}

		case SaxEventType.Doctype: {
			// Typically: string
			console.log("doctype:", detail);
			break;
		}

		default: {
			// Useful while you’re discovering what your build emits.
			console.log("event:", event, detail);
			break;
      }
  }

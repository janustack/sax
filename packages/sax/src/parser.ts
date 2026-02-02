import {
	BUFFERS,
	CDATA_SECTION_OPEN,
	DOCTYPE_KEYWORD,
	ENTITIES,
	NAMESPACES,
	PREDEFINED_INTERNAL_ENTITIES,
	State,
} from "./constants.js";
import { SAXParserError } from "./error.js";
import type { SAXOptions } from "./types.js";
import {
	charAt,
	getQName,
	isAttribEnd,
	isMatch,
	isQuote,
	isWhitespace,
	notMatch,
	textopts,
} from "./utils.js";

const MAX_BUFFER_LENGTH = 64 * 1024;

const REGEX = {
	ENTITY_BODY:
		/[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
	ENTITY_START:
		/[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
	NAME_BODY:
		/[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
	NAME_START:
		/[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
} as const;

export class SAXParser {
	error: Error | null = null;
	isClosed: boolean = false;
	closedRoot: boolean = false;
	hasSeenRoot: boolean = false;
	isStrict: boolean = false;
	public columnNumber: number = 0;
	public lineNumber: number = 0;
	public options: SAXOptions;
	public position: number = 0;

	public onReady?: () => void;
	public onEnd?: () => void;
	public onError?: (error: Error) => void;
	public onText?: (text: string) => void;
	public onComment?: (comment: string) => void;
	public onCdata?: (cdata: string) => void;
	public onDoctype?: (doctype: string) => void;
	public onProcessingInstruction?: (data: {
		name: string;
		body: string;
	}) => void;
	public onOpenTagStart?: (tag: any) => void;
	public onOpenTag?: (tag: any) => void;
	public onCloseTag?: (name: string) => void;
	public onAttribute?: (attribute: any) => void;
	public onOpenNamespace?: (ns: { prefix: string; uri: string }) => void;
	public onCloseNamespace?: (ns: { prefix: string; uri: string }) => void;
	public onOpenCdata?: () => void;
	public onCloseCdata?: () => void;
	public onSgmlDeclaration?: (declaration: string) => void;
	public onScript?: (script: string) => void;

	private bufferCheckPosition: number = MAX_BUFFER_LENGTH;
	private caseTransform: "toLowerCase" | "toUpperCase";
	private char: string = "";
	private qName: string = "";

	constructor(isStrict: boolean = false, options: SAXOptions = {}) {
		this.clearBuffers();
		this.options = options;
		this.options.lowercase =
			this.options.lowercase || this.options.lowercaseTags;
		this.caseTransform = this.options.lowercase ? "toLowerCase" : "toUpperCase";
		this.tags = [];
		this.tag = null;
		this.error = null;
		this.isStrict = isStrict;
		this.noscript = Boolean(isStrict || this.options.noscript);
		this.state = State.BEGIN;
		this.strictEntities = this.options.strictEntities;
		this.attribList = [];

		// namespaces form a prototype chain.
		// it always points at the current tag,
		// which protos to its parent tag.
		if (this.options.xmlns) {
			this.ns = Object.create(NAMESPACES);
		}

		// disallow unquoted attribute values if not otherwise configured
		// and strict mode is true
		if (this.options.unquotedAttributeValues === undefined) {
			this.options.unquotedAttributeValues = !isStrict;
		}

		// mostly just for error reporting
		this.trackPosition = this.options.position !== false;

		this.reset();
	}

	private reset(): void {
		this.clearBuffers();
		this.char = "";
		this.qName = "";
		this.bufferCheckPosition = MAX_BUFFER_LENGTH;
		this.tags = [];
		this.isClosed = false;
		this.closedRoot = false;
		this.hasSeenRoot = false;
		this.tag = null;
		this.error = null;
		this.state = State.BEGIN;

		this.strictEntities = this.options.strictEntities;
		this.ENTITIES = this.strictEntities
			? Object.create(PREDEFINED_INTERNAL_ENTITIES)
			: Object.create(ENTITIES);

		this.attribList = [];

		if (this.options.xmlns) {
			this.ns = Object.create(NAMESPACES);
		}

		if (this.trackPosition) {
			this.position = 0;
			this.lineNumber = 0;
			this.columnNumber = 0;
		}

		this.emit("onReady");
	}

	public close(): this {
		return this.write(null);
	}

	public end(): this {
		if (this.hasSeenRoot && !this.closedRoot) {
			this.strictFail("Unclosed root tag");
		}

		if (
			this.state !== State.BEGIN &&
			this.state !== State.BEGIN_WHITESPACE &&
			this.state !== State.TEXT
		) {
			this.error("Unexpected end");
		}

		this.closeText();
		this.char = "";
		this.isClosed = true;
		this.emit("onEnd");
		this.reset();

		return this;
	}

	public flush(): void {
		this.flushBuffers();
	}

	public resume(): this {
		this.error = null;
		return this;
	}

	public write(chunk: Buffer | null | string): this {
		if (this.error) {
			throw this.error;
		}

		if (this.isClosed) {
			return this.error("Cannot write after close. Assign an onready handler.");
		}

		if (chunk === null) {
			return this.end();
		}

		if (typeof chunk === "object") {
			chunk = chunk.toString();
		}

		let i = 0;
		let char = "";

		while (true) {
			char = charAt(chunk, i++);
			this.char = char;

			if (!char) {
				break;
			}

			if (this.trackPosition) {
				this.position++;
				if (char === "\n") {
					this.lineNumber++;
					this.columnNumber = 0;
				} else {
					this.columnNumber++;
				}
			}

			switch (this.state) {
				case State.BEGIN: {
					this.state = State.BEGIN_WHITESPACE;
					if (char === "\uFEFF") {
						continue;
					}
					this.beginWhiteSpace(char);
					continue;
				}

				case State.BEGIN_WHITESPACE: {
					this.beginWhiteSpace(char);
					continue;
				}

				case State.TEXT: {
					if (this.hasSeenRoot && !this.closedRoot) {
						const startIndex = i - 1;
						while (char && char !== "<" && char !== "&") {
							char = charAt(chunk, i++);
							if (char && this.trackPosition) {
								this.position++;
								if (char === "\n") {
									this.lineNumber++;
									this.columnNumber = 0;
								} else {
									this.columnNumber++;
								}
							}
						}
						this.textNode += chunk.substring(startIndex, i - 1);
					}
					if (
						char === "<" &&
						!(this.hasSeenRoot && this.closedRoot && !this.isStrict)
					) {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
					} else {
						if (!isWhitespace(char) && (!this.hasSeenRoot || this.closedRoot)) {
							this.strictFail("Text data outside of root node.");
						}
						if (char === "&") {
							this.state = State.TEXT_ENTITY;
						} else {
							this.textNode += char;
						}
					}
					continue;
				}

				case State.SCRIPT: {
					// only non-strict
					if (char === "<") {
						this.state = State.SCRIPT_ENDING;
					} else {
						this.script += char;
					}
					continue;
				}

				case State.SCRIPT_ENDING: {
					if (char === "/") {
						this.state = State.CLOSE_TAG;
					} else {
						this.script += `<${char}`;
						this.state = State.SCRIPT;
					}
					continue;
				}

				case State.OPEN_WAKA: {
					// either a /, ?, !, or text is coming next.
					if (char === "!") {
						this.state = State.SGML_DECLARATION;
						this.sgmlDeclaration = "";
					} else if (isWhitespace(char)) {
						// wait for it...
					} else if (isMatch(REGEX.NAME_START, char)) {
						this.state = State.OPEN_TAG;
						this.tagName = char;
					} else if (char === "/") {
						this.state = State.CLOSE_TAG;
						this.tagName = "";
					} else if (char === "?") {
						this.state = State.PROC_INST;
						this.procInstName = this.procInstBody = "";
					} else {
						this.strictFail("Unencoded <");
						// if there was some whitespace, then add that in.
						if (this.startTagPosition + 1 < this.position) {
							const pad = this.position - this.startTagPosition;
							char = new Array(pad).join(" ") + char;
						}
						this.textNode += `<${char}`;
						this.state = State.TEXT;
					}
					continue;
				}

				case State.SGML_DECLARATION: {
					if (this.sgmlDeclaration + char === "--") {
						this.state = State.COMMENT;
						this.comment = "";
						this.sgmlDeclaration = "";
						continue;
					}

					if (this.doctype && this.doctype !== true && this.sgmlDeclaration) {
						this.state = State.DOCTYPE_DTD;
						this.doctype += `<!${this.sgmlDeclaration}${char}`;
						this.sgmlDeclaration = "";
					} else if (
						(this.sgmlDeclaration + char).toUpperCase() === CDATA_SECTION_OPEN
					) {
						this.emitNode("onOpenCdata");
						this.state = State.CDATA;
						this.sgmlDeclaration = "";
						this.cdata = "";
					} else if (
						(this.sgmlDeclaration + char).toUpperCase() === DOCTYPE_KEYWORD
					) {
						this.state = State.DOCTYPE;
						if (this.doctype || this.hasSeenRoot) {
							this.strictFail("Inappropriately located doctype declaration");
						}
						this.doctype = "";
						this.sgmlDeclaration = "";
					} else if (char === ">") {
						this.emitNode("onSgmlDeclaration", this.sgmlDeclaration);
						this.sgmlDeclaration = "";
						this.state = State.TEXT;
					} else if (isQuote(char)) {
						this.state = State.SGML_DECL_QUOTED;
						this.sgmlDeclaration += char;
					} else {
						this.sgmlDeclaration += char;
					}
					continue;
				}

				case State.SGML_DECL_QUOTED: {
					if (char === this.qName) {
						this.state = State.SGML_DECLARATION;
						this.qName = "";
					}
					this.sgmlDeclaration += char;
					continue;
				}

				case State.DOCTYPE: {
					if (char === ">") {
						this.state = State.TEXT;
						this.emitNode("onDoctype", this.doctype);
						this.doctype = true; // just remember that we saw it.
					} else {
						this.doctype += char;
						if (char === "[") {
							this.state = State.DOCTYPE_DTD;
						} else if (isQuote(char)) {
							this.state = State.DOCTYPE_QUOTED;
							this.qName = char;
						}
					}
					continue;
				}

				case State.DOCTYPE_QUOTED: {
					this.doctype += char;
					if (char === this.qName) {
						this.qName = "";
						this.state = State.DOCTYPE;
					}
					continue;
				}

				case State.DOCTYPE_DTD: {
					if (char === "]") {
						this.doctype += char;
						this.state = State.DOCTYPE;
					} else if (char === "<") {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
					} else if (isQuote(char)) {
						this.doctype += char;
						this.state = State.DOCTYPE_DTD_QUOTED;
						this.qName = char;
					} else {
						this.doctype += char;
					}
					continue;
				}

				case State.DOCTYPE_DTD_QUOTED: {
					this.doctype += char;
					if (char === this.qName) {
						this.state = State.DOCTYPE_DTD;
						this.qName = "";
					}
					continue;
				}

				case State.COMMENT: {
					if (char === "-") {
						this.state = State.COMMENT_ENDING;
					} else {
						this.comment += char;
					}
					continue;
				}

				case State.COMMENT_ENDING: {
					if (char === "-") {
						this.state = State.COMMENT_ENDED;
						this.comment = textopts(this.options, this.comment);
						if (this.comment) {
							this.emitNode("onComment", this.comment);
						}
						this.comment = "";
					} else {
						this.comment += `-${char}`;
						this.state = State.COMMENT;
					}
					continue;
				}

				case State.COMMENT_ENDED: {
					if (char !== ">") {
						this.strictFail("Malformed comment");
						// allow <!-- blah -- bloo --> in non-strict mode,
						// which is a comment of " blah -- bloo "
						this.comment += `--${char}`;
						this.state = State.COMMENT;
					} else if (this.doctype && this.doctype !== true) {
						this.state = State.DOCTYPE_DTD;
					} else {
						this.state = State.TEXT;
					}
					continue;
				}

				case State.CDATA: {
					const startIndex = i - 1;

					while (char && char !== "]") {
						char = charAt(chunk, i++);
						if (char && this.trackPosition) {
							this.position++;

							if (char === "\n") {
								this.lineNumber++;
								this.columnNumber = 0;
							} else {
								this.columnNumber++;
							}
						}
					}

					this.cdata += chunk.substring(startIndex, i - 1);

					if (char === "]") {
						this.state = State.CDATA_ENDING;
					}
					continue;
				}

				case State.CDATA_ENDING: {
					if (char === "]") {
						this.state = State.CDATA_ENDING_2;
					} else {
						this.cdata += `]${char}`;
						this.state = State.CDATA;
					}
					continue;
				}

				case State.CDATA_ENDING_2: {
					if (char === ">") {
						if (this.cdata) {
							this.emitNode("onCdata", this.cdata);
						}
						this.emitNode("onCloseCdata");
						this.cdata = "";
						this.state = State.TEXT;
					} else if (char === "]") {
						this.cdata += "]";
					} else {
						this.cdata += `]]${char}`;
						this.state = State.CDATA;
					}
					continue;
				}

				case State.PROC_INST: {
					if (char === "?") {
						this.state = State.PROC_INST_ENDING;
					} else if (isWhitespace(char)) {
						this.state = State.PROC_INST_BODY;
					} else {
						this.procInstName += char;
					}
					continue;
				}

				case State.PROC_INST_BODY: {
					if (!this.procInstBody && isWhitespace(char)) {
						continue;
					} else if (char === "?") {
						this.state = State.PROC_INST_ENDING;
					} else {
						this.procInstBody += char;
					}
					continue;
				}

				case State.PROC_INST_ENDING: {
					if (char === ">") {
						this.emitNode("onProcessingInstruction", {
							name: this.procInstName,
							body: this.procInstBody,
						});
						this.procInstName = this.procInstBody = "";
						this.state = State.TEXT;
					} else {
						this.procInstBody += `?${char}`;
						this.state = State.PROC_INST_BODY;
					}
					continue;
				}

				case State.OPEN_TAG: {
					if (isMatch(REGEX.NAME_BODY, char)) {
						this.tagName += char;
					} else {
						this.newTag();
						if (char === ">") {
							this.openTag();
						} else if (char === "/") {
							this.state = State.OPEN_TAG_SLASH;
						} else {
							if (!isWhitespace(char)) {
								this.strictFail("Invalid character in tag name");
							}
							this.state = State.ATTRIB;
						}
					}
					continue;
				}

				case State.OPEN_TAG_SLASH: {
					if (char === ">") {
						this.openTag(true);
						this.closeTag();
					} else {
						this.strictFail("Forward-slash in opening tag not followed by >");
						this.state = State.ATTRIB;
					}
					continue;
				}

				case State.ATTRIB: {
					if (isWhitespace(char)) {
						continue;
					} else if (char === ">") {
						this.openTag();
					} else if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
					} else if (isMatch(REGEX.NAME_START, char)) {
						this.attribName = char;
						this.attribValue = "";
						this.state = State.ATTRIB_NAME;
					} else {
						this.strictFail("Invalid attribute name");
					}
					continue;
				}

				case State.ATTRIB_NAME: {
					if (char === "=") {
						this.state = State.ATTRIB_VALUE;
					} else if (char === ">") {
						this.strictFail("Attribute without value");
						this.attribValue = this.attribName;
						this.attrib();
						this.openTag();
					} else if (isWhitespace(char)) {
						this.state = State.ATTRIB_NAME_SAW_WHITE;
					} else if (isMatch(REGEX.NAME_BODY, char)) {
						this.attribName += char;
					} else {
						this.strictFail("Invalid attribute name");
					}
					continue;
				}

				case State.ATTRIB_NAME_SAW_WHITE: {
					if (char === "=") {
						this.state = State.ATTRIB_VALUE;
					} else if (isWhitespace(char)) {
						continue;
					} else {
						this.strictFail("Attribute without value");
						this.tag.attributes[this.attribName] = "";
						this.attribValue = "";
						this.emitNode("onAttribute", {
							name: this.attribName,
							value: "",
						});
						this.attribName = "";
						if (char === ">") {
							this.openTag();
						} else if (isMatch(REGEX.NAME_START, char)) {
							this.attribName = char;
							this.state = State.ATTRIB_NAME;
						} else {
							this.strictFail("Invalid attribute name");
							this.state = State.ATTRIB;
						}
					}
					continue;
				}

				case State.ATTRIB_VALUE: {
					if (isWhitespace(char)) {
						continue;
					} else if (isQuote(char)) {
						this.qName = char;
						this.state = State.ATTRIB_VALUE_QUOTED;
					} else {
						if (!this.options.unquotedAttributeValues) {
							this.error("Unquoted attribute value");
						}
						this.state = State.ATTRIB_VALUE_UNQUOTED;
						this.attribValue = char;
					}
					continue;
				}

				case State.ATTRIB_VALUE_QUOTED: {
					if (char !== this.qName) {
						if (char === "&") {
							this.state = State.ATTRIB_VALUE_ENTITY_Q;
						} else {
							this.attribValue += char;
						}
						continue;
					}
					this.attrib();
					this.qName = "";
					this.state = State.ATTRIB_VALUE_CLOSED;
					continue;
				}

				case State.ATTRIB_VALUE_CLOSED: {
					if (isWhitespace(char)) {
						this.state = State.ATTRIB;
					} else if (char === ">") {
						this.openTag();
					} else if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
					} else if (isMatch(REGEX.NAME_START, char)) {
						this.strictFail("No whitespace between attributes");
						this.attribName = char;
						this.attribValue = "";
						this.state = State.ATTRIB_NAME;
					} else {
						this.strictFail("Invalid attribute name");
					}
					continue;
				}

				case State.ATTRIB_VALUE_UNQUOTED: {
					if (!isAttribEnd(char)) {
						if (char === "&") {
							this.state = State.ATTRIB_VALUE_ENTITY_U;
						} else {
							this.attribValue += char;
						}
						continue;
					}
					this.attrib();
					if (char === ">") {
						this.openTag();
					} else {
						this.state = State.ATTRIB;
					}
					continue;
				}

				case State.CLOSE_TAG: {
					if (!this.tagName) {
						if (isWhitespace(char)) {
							continue;
						} else if (notMatch(REGEX.NAME_START, char)) {
							if (this.script) {
								this.script += `</${char}`;
								this.state = State.SCRIPT;
							} else {
								this.strictFail("Invalid tagname in closing tag.");
							}
						} else {
							this.tagName = char;
						}
					} else if (char === ">") {
						this.closeTag();
					} else if (isMatch(REGEX.NAME_BODY, char)) {
						this.tagName += char;
					} else if (this.script) {
						this.script += `</${this.tagName}${char}`;
						this.tagName = "";
						this.state = State.SCRIPT;
					} else {
						if (!isWhitespace(char)) {
							this.strictFail("Invalid tagname in closing tag");
						}
						this.state = State.CLOSE_TAG_SAW_WHITE;
					}
					continue;
				}

				case State.CLOSE_TAG_SAW_WHITE: {
					if (isWhitespace(char)) {
						continue;
					}
					if (char === ">") {
						this.closeTag();
					} else {
						this.strictFail("Invalid characters in closing tag");
					}
					continue;
				}

				case State.TEXT_ENTITY:
				case State.ATTRIB_VALUE_ENTITY_Q:
				case State.ATTRIB_VALUE_ENTITY_U: {
					let returnState;
					let buffer;

					switch (this.state) {
						case State.TEXT_ENTITY:
							returnState = State.TEXT;
							buffer = "textNode";
							break;

						case State.ATTRIB_VALUE_ENTITY_Q:
							returnState = State.ATTRIB_VALUE_QUOTED;
							buffer = "attribValue";
							break;

						case State.ATTRIB_VALUE_ENTITY_U:
							returnState = State.ATTRIB_VALUE_UNQUOTED;
							buffer = "attribValue";
							break;
					}

					if (char === ";") {
						const parsedEntity = this.parseEntity();
						if (
							this.options.unparsedEntities &&
							!Object.values(PREDEFINED_INTERNAL_ENTITIES).includes(
								parsedEntity,
							)
						) {
							this.entity = "";
							this.state = returnState;
							this.write(parsedEntity);
						} else {
							this[buffer] += parsedEntity;
							this.entity = "";
							this.state = returnState;
						}
					} else if (
						isMatch(
							this.entity.length ? REGEX.ENTITY_BODY : REGEX.ENTITY_START,
							char,
						)
					) {
						this.entity += char;
					} else {
						this.strictFail("Invalid character in entity name");
						this[buffer] += `&${this.entity}${char}`;
						this.entity = "";
						this.state = returnState;
					}

					continue;
				}

				default: /* istanbul ignore next */ {
					throw new Error(`Unknown state: ${this.state}`);
				}
			}
		} // while

		if (this.position >= this.bufferCheckPosition) {
			this.checkBufferLength();
		}
		return this;
	}

	private attrib(): void {
		if (!this.isStrict) {
			this.attribName = this.attribName[this.caseTransform]();
		}

		if (
			this.attribList.includes(this.attribName) ||
			Object.hasOwn(this.tag.attributes, this.attribName)
		) {
			this.attribName = this.attribValue = "";
			return;
		}

		if (this.options.xmlns) {
			const qName = getQName(this.attribName, true);
			const prefix = qName.prefix;
			const localName = qName.localName;

			if (prefix === "xmlns") {
				// namespace binding attribute. push the binding into scope
				if (localName === "xml" && this.attribValue !== NAMESPACES.XML) {
					this.strictFail(
						"xml: prefix must be bound to " +
							NAMESPACES.XML +
							"\n" +
							"Actual: " +
							this.attribValue,
					);
				} else if (
					localName === "xmlns" &&
					this.attribValue !== NAMESPACES.XMLNS
				) {
					this.strictFail(
						"xmlns: prefix must be bound to " +
							NAMESPACES.XMLNS +
							"\n" +
							"Actual: " +
							this.attribValue,
					);
				} else {
					const tag = this.tag;
					const parent = this.tags.at(-1) || this;
					if (tag.ns === parent.ns) {
						tag.ns = Object.create(parent.ns);
					}
					tag.ns[localName] = this.attribValue;
				}
			}

			// defer onattribute events until all attributes have been seen
			// so any new bindings can take effect. preserve attribute order
			// so deferred events can be emitted in document order
			this.attribList.push([this.attribName, this.attribValue]);
		} else {
			// in non-xmlns mode, we can emit the event right away
			this.tag.attributes[this.attribName] = this.attribValue;
			this.emitNode("onAttribute", {
				name: this.attribName,
				value: this.attribValue,
			});
		}

		this.attribName = this.attribValue = "";
	}

	private beginWhiteSpace(char: string): void {
		if (char === "<") {
			this.state = State.OPEN_WAKA;
			this.startTagPosition = this.position;
		} else if (!isWhitespace(char)) {
			// have to process this as a text node.
			// weird, but happens.
			this.strictFail("Non-whitespace before first tag.");
			this.textNode = char;
			this.state = State.TEXT;
		}
	}

	private checkBufferLength(): void {
		const maxAllowed = Math.max(MAX_BUFFER_LENGTH, 10);
		let maxActual = 0;

		for (const buffer of BUFFERS) {
			const len = this[buffer].length;

			if (len > maxAllowed) {
				// Text/cdata nodes can get big, and since they're buffered,
				// we can get here under normal conditions.
				// Avoid issues by emitting the text node now,
				// so at least it won't get any bigger.
				switch (buffer) {
					case "textNode": {
						this.closeText();
						break;
					}

					case "cdata": {
						this.emitNode("onCdata", this.cdata);
						this.cdata = "";
						break;
					}

					case "script": {
						this.emitNode("onScript", this.script);
						this.script = "";
						break;
					}

					default: {
						this.error(`Max buffer length exceeded: ${buffer}`);
					}
				}
			}

			maxActual = Math.max(maxActual, len);
		}

		this.bufferCheckPosition = MAX_BUFFER_LENGTH - maxActual + this.position;
	}

	private clearBuffers(): void {
		for (const buffer of BUFFERS) {
			this[buffer] = "";
		}
	}

	private closeTag(): void {
		if (!this.tagName) {
			this.strictFail("Weird empty close tag.");
			this.textNode += "</>";
			this.state = State.TEXT;
			return;
		}

		if (this.script) {
			if (this.tagName !== "script") {
				this.script += `</${this.tagName}>`;
				this.tagName = "";
				this.state = State.SCRIPT;
				return;
			}
			this.emitNode("onScript", this.script);
			this.script = "";
		}

		// first make sure that the closing tag actually exists.
		// <a><b></c></b></a> will close everything, otherwise.
		var t: number = this.tags.length;
		var tagName: string = this.tagName;

		if (!this.isStrict) {
			tagName = tagName[this.caseTransform]();
		}

		const closeTo: string = tagName;

		while (t--) {
			const close = this.tags[t];

			if (close.name !== closeTo) {
				// fail the first time in strict mode
				this.strictFail("Unexpected close tag");
			} else {
				break;
			}
		}

		// didn't find it.  we already failed for strict, so just abort.
		if (t < 0) {
			this.strictFail(`Unmatched closing tag: ${this.tagName}`);
			this.textNode += `</${this.tagName}>`;
			this.state = State.TEXT;
			return;
		}

		this.tagName = tagName;

		let s = this.tags.length;
		while (s > t) {
			s -= 1;

			this.tag = this.tags.pop();
			const tag = this.tag;

			this.tagName = this.tag.name;
			this.emitNode("onCloseTag", this.tagName);

			const x = {};
			for (const i in tag.ns) {
				x[i] = tag.ns[i];
			}

			const parent = this.tags.at(-1) || this;

			if (this.options.xmlns && tag.ns !== parent.ns) {
				// remove namespace bindings introduced by tag
				Object.keys(tag.ns).forEach((p) => {
					const n = tag.ns[p];
					this.emitNode("onCloseNamespace", { prefix: p, uri: n });
				});
			}
		}

		if (t === 0) this.closedRoot = true;

		this.tagName = this.attribValue = this.attribName = "";
		this.attribList.length = 0;
		this.state = State.TEXT;
	}

	private closeText() {
		this.textNode = textopts(this.options, this.textNode);
		if (this.textNode) this.emit("onText", this.textNode);
		this.textNode = "";
	}

	private emit(event: string, data?: any): void {
		this[event]?.(data);
	}

	private emitNode(nodeType, data): void {
		if (this.textNode) {
			this.closeText();
		}
		this.emit(nodeType, data);
	}

	private _error(message: string): this {
		this.closeText();

		const error = new SAXParserError(message, this.columnNumber);

		this.error = error;
		this.emit("onError", error);
		return this;
	}

	private flushBuffers(): void {
		this.closeText();
		if (this.cdata !== "") {
			this.emitNode("onCdata", this.cdata);
			this.cdata = "";
		}
		if (this.script !== "") {
			this.emitNode("onScript", this.script);
			this.script = "";
		}
	}

	private newTag(): void {
		if (!this.isStrict) {
			this.tagName = this.tagName[this.caseTransform]();
		}

		const parent = this.tags.at(-1) || this;
		const tag = (this.tag = {
			name: this.tagName,
			attributes: {},
		});

		// will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
		if (this.options.xmlns) {
			tag.ns = parent.ns;
		}

		this.attribList.length = 0;
		this.emitNode("onOpenTagStart", tag);
	}

	private openTag(selfClosing): void {
		if (this.options.xmlns) {
			const tag = this.tag;
			const qName = getQName(this.tagName);

			tag.prefix = qName.prefix;
			tag.localName = qName.localName;
			tag.uri = tag.ns[qName.prefix] || "";

			if (tag.prefix && !tag.uri) {
				this.strictFail(
					`Unbound namespace prefix: ${JSON.stringify(this.tagName)}`,
				);
				tag.uri = qName.prefix;
			}

			const parent = this.tags.at(-1) || this;
			if (tag.ns && parent.ns !== tag.ns) {
				Object.keys(tag.ns).forEach((p) => {
					this.emitNode("onOpenNamespace", {
						prefix: p,
						uri: tag.ns[p],
					});
				});
			}

			// handle deferred onattribute events
			// Note: do not apply default ns to attributes:
			//   http://www.w3.org/TR/REC-xml-names/#defaulting
			for (const [name, value] of this.attribList) {
				const qName = getQName(name, true);
				const prefix = qName.prefix;
				const localName = qName.localName;
				const uri = prefix === "" ? "" : tag.ns[prefix] || "";

				const a = {
					name: name,
					value: value,
					prefix: prefix,
					localName: localName,
					uri: uri,
				};

				// if there's any attributes with an undefined namespace,
				// then fail on them now.
				if (prefix && prefix !== "xmlns" && !uri) {
					this.strictFail(
						`Unbound namespace prefix: ${JSON.stringify(prefix)}`,
					);
					a.uri = prefix;
				}
				this.tag.attributes[name] = a;
				this.emitNode("onAttribute", a);
			}
			this.attribList.length = 0;
		}

		this.tag.isSelfClosing = !!selfClosing;

		// process the tag
		this.hasSeenRoot = true;
		this.tags.push(this.tag);
		this.emitNode("onOpenTag", this.tag);
		if (!selfClosing) {
			// special case for <script> in non-strict mode.
			if (!this.noscript && this.tagName.toLowerCase() === "script") {
				this.state = State.SCRIPT;
			} else {
				this.state = State.TEXT;
			}
			this.tag = null;
			this.tagName = "";
		}
		this.attribName = this.attribValue = "";
		this.attribList.length = 0;
	}

	private parseEntity(): string {
		let entity = this.entity;
		const entityLC = entity.toLowerCase();
		let number: number;
		let numStr = "";

		if (this.ENTITIES[entity]) {
			return this.ENTITIES[entity];
		}

		if (this.ENTITIES[entityLC]) {
			return this.ENTITIES[entityLC];
		}

		entity = entityLC;

		if (entity.charAt(0) === "#") {
			if (entity.charAt(1) === "x") {
				entity = entity.slice(2);
				number = parseInt(entity, 16);
				numStr = number.toString(16);
			} else {
				entity = entity.slice(1);
				number = parseInt(entity, 10);
				numStr = number.toString(10);
			}
		}

		entity = entity.replace(/^0+/, "");

		if (
			Number.isNaN(number) ||
			numStr.toLowerCase() !== entity ||
			number < 0 ||
			number > 0x10ffff
		) {
			this.strictFail("Invalid character entity");
			return `&${this.entity};`;
		}

		return String.fromCodePoint(number);
	}

	private strictFail(message: string): void {
		if (typeof this !== "object" || !(this instanceof SAXParser)) {
			throw new Error("bad call to strictFail");
		}
		if (this.isStrict) {
			this.error(message);
		}
	}
}

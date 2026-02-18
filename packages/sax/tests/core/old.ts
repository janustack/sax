((sax) => {
	// wrapper for non-node envs
	sax.parser = (strict: boolean, options) => {
		return new SAXParser(strict, options);
	};
	sax.SAXParser = SAXParser;
	sax.SAXStream = SAXStream;
	sax.createStream = createStream;

	sax.MAX_BUFFER_LENGTH = 64 * 1024;

	var CDATA = "[CDATA[";
	var DOCTYPE = "DOCTYPE";
	var NAMESPACES = {
		xml: "http://www.w3.org/XML/1998/namespace",
		xmlns: "http://www.w3.org/2000/xmlns/",
	} as const;
	var REGEX = {
		ENTITY_BODY:
			/[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
		ENTITY_START:
			/[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
		NAME_BODY:
			/[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
		NAME_START:
			/[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
	} as const;

	var buffers = [
		"comment",
		"sgmlDecl",
		"textNode",
		"tagName",
		"doctype",
		"procInstName",
		"procInstBody",
		"entity",
		"attributeName",
		"attributeValue",
		"cdata",
		"script",
	];

	sax.EVENTS = [
		"text",
		"processingInstruction",
		"sgmlDeclaration",
		"doctype",
		"comment",
		"openTagStart",
		"attribute",
		"openTag",
		"closeTag",
		"openCdata",
		"cdata",
		"closeCdata",
		"error",
		"end",
		"ready",
		"script",
		"openNamespace",
		"closeNamespace",
	];

	function SAXParser(strict: boolean, options) {
		if (!(this instanceof SAXParser)) {
			return new SAXParser(strict, options);
		}

		clearBuffers(this);
		this.quoteChar = this.char = "";
		this.bufferCheckPosition = sax.MAX_BUFFER_LENGTH;
		this.options = options || {};
		this.options.lowercase =
			this.options.lowercase || this.options.lowercasetags;
		this.caseTransform = this.options.lowercase ? "toLowerCase" : "toUpperCase";
		this.tags = [];
		this.closed = this.closedRoot = this.hasSeenRoot = false;
		this.tag = this.error = null;
		this.strict = !!strict;
		this.noScript = !!(strict || this.options.noScript);
		this.state = State.BEGIN;
		this.strictEntities = this.options.strictEntities;
		this.ENTITIES = this.strictEntities
			? Object.create(sax.XML_PREDEFINED_ENTITIES)
			: Object.create(sax.ENTITIES);
		this.attributeList = [];

		// namespaces form a prototype chain.
		// it always points at the current tag,
		// which protos to its parent tag.
		if (this.options.namespaces) {
			this.ns = Object.create(NAMESPACES);
		}

		// disallow unquoted attribute values if not otherwise configured
		// and strict mode is true
		if (this.options.unquotedAttributeValues === undefined) {
			this.options.unquotedAttributeValues = !strict;
		}

		// mostly just for error reporting
		this.trackPosition = this.options.position !== false;
		if (this.trackPosition) {
			this.position = this.line = this.column = 0;
		}
		emit(this, "onReady");
	}

	if (!Object.create) {
		Object.create = (o) => {
			function F() {}
			F.prototype = o;
			var newf = new F();
			return newf;
		};
	}

	if (!Object.keys) {
		Object.keys = (o) => {
			var a = [];
			for (var i in o) if (o.hasOwnProperty(i)) a.push(i);
			return a;
		};
	}

	function checkBufferLength(parser): void {
		var maxAllowed = Math.max(sax.MAX_BUFFER_LENGTH, 10);
		var maxActual = 0;
		for (var i = 0, l = buffers.length; i < l; i++) {
			var len = parser[buffers[i]].length;
			if (len > maxAllowed) {
				// Text/cdata nodes can get big, and since they're buffered,
				// we can get here under normal conditions.
				// Avoid issues by emitting the text node now,
				// so at least it won't get any bigger.
				switch (buffers[i]) {
					case "textNode":
						closeText(parser);
						break;

					case "cdata":
						emitNode(parser, "onCdata", parser.cdata);
						parser.cdata = "";
						break;

					case "script":
						emitNode(parser, "onScript", parser.script);
						parser.script = "";
						break;

					default:
						fail(parser, "Max buffer length exceeded: " + buffers[i]);
				}
			}
			maxActual = Math.max(maxActual, len);
		}
		// schedule the next check for the earliest possible buffer overrun.
		var m = sax.MAX_BUFFER_LENGTH - maxActual;
		parser.bufferCheckPosition = m + parser.position;
	}

	function clearBuffers(parser) {
		for (var i = 0, l = buffers.length; i < l; i++) {
			parser[buffers[i]] = "";
		}
	}

	function flushBuffers(parser) {
		closeText(parser);
		if (parser.cdata !== "") {
			emitNode(parser, "onCdata", parser.cdata);
			parser.cdata = "";
		}
		if (parser.script !== "") {
			emitNode(parser, "onScript", parser.script);
			parser.script = "";
		}
	}

	SAXParser.prototype = {
		end: function () {
			end(this);
		},
		write: write,
		resume: function () {
			this.error = null;
			return this;
		},
		close: function () {
			return this.write(null);
		},
		flush: function () {
			flushBuffers(this);
		},
	};

	var Stream;
	try {
		Stream = require("node:stream").Stream;
	} catch (ex) {
		Stream = () => {};
	}
	if (!Stream) Stream = () => {};

	var streamWraps = sax.EVENTS.filter((event) => {
		return event !== "error" && event !== "end";
	});

	function createStream(strict: boolean, options) {
		return new SAXStream(strict, options);
	}

	function SAXStream(strict: boolean, options) {
		if (!(this instanceof SAXStream)) {
			return new SAXStream(strict, options);
		}

		Stream.apply(this);

		this._parser = new SAXParser(strict, options);
		this.writable = true;
		this.readable = true;

		this._parser.onEnd = () => {
			this.emit("end");
		};

		this._parser.onError = (error) => {
			this.emit("error", error);

			// if didn't throw, then means error was handled.
			// go ahead and clear error, so we can write again.
			this._parser.error = null;
		};

		this._decoder = null;

		streamWraps.forEach((event) => {
			Object.defineProperty(this, "on" + event, {
				get: () => {
					return this._parser["on" + event];
				},
				set: (h) => {
					if (!h) {
						this.removeAllListeners(event);
						this._parser["on" + event] = h;
						return h;
					}
					this.on(event, h);
				},
				enumerable: true,
				configurable: false,
			});
		});
	}

	SAXStream.prototype = Object.create(Stream.prototype, {
		constructor: {
			value: SAXStream,
		},
	});

	SAXStream.prototype.write = function (data) {
		if (
			typeof Buffer === "function" &&
			typeof Buffer.isBuffer === "function" &&
			Buffer.isBuffer(data)
		) {
			if (!this._decoder) {
				this._decoder = new TextDecoder("utf8");
			}
			data = this._decoder.decode(data, { stream: true });
		}

		this._parser.write(data.toString());
		this.emit("data", data);
		return true;
	};

	SAXStream.prototype.end = function (chunk) {
		if (chunk && chunk.length) {
			this.write(chunk);
		}
		// Flush any remaining decoded data from the TextDecoder
		if (this._decoder) {
			var remaining = this._decoder.decode();
			if (remaining) {
				this._parser.write(remaining);
				this.emit("data", remaining);
			}
		}
		this._parser.end();
		return true;
	};

	SAXStream.prototype.on = function (event, handler) {
		if (!this._parser["on" + event] && streamWraps.indexOf(event) !== -1) {
			this._parser["on" + event] = function () {
				var args =
					arguments.length === 1
						? [arguments[0]]
						: Array.apply(null, arguments);
				args.splice(0, 0, event);
				this.emit.apply(this, args);
			};
		}

		return Stream.prototype.on.call(this, event, handler);
	};

	// http://www.w3.org/TR/REC-xml/#NT-NameStartChar
	// This implementation works on strings, a single character at a time
	// as such, it cannot ever support astral-plane characters (10000-EFFFF)
	// without a significant breaking change to either this  parser, or the
	// JavaScript language.  Implementation of an emoji-capable xml parser
	// is left as an exercise for the reader.

	function isWhitespace(char: string): boolean {
		return char === " " || char === "\n" || char === "\r" || char === "\t";
	}

	function isQuote(char: string): boolean {
		return char === '"' || char === "'";
	}

	function isAttributeEnd(char: string): boolean {
		return char === ">" || isWhitespace(char);
	}

	function isMatch(regex: RegExp, char: string): boolean {
		return regex.test(char);
	}

	var S = 0;
	sax.STATE = {
		BEGIN: S++, // leading byte order mark or whitespace
		BEGIN_WHITESPACE: S++, // leading whitespace
		TEXT: S++, // general stuff
		TEXT_ENTITY: S++, // &amp and such.
		OPEN_WAKA: S++, // <
		SGML_DECL: S++, // <!BLARG
		SGML_DECL_QUOTED: S++, // <!BLARG foo "bar
		DOCTYPE: S++, // <!DOCTYPE
		DOCTYPE_QUOTED: S++, // <!DOCTYPE "//blah
		DOCTYPE_DTD: S++, // <!DOCTYPE "//blah" [ ...
		DOCTYPE_DTD_QUOTED: S++, // <!DOCTYPE "//blah" [ "foo
		COMMENT_startIndexNG: S++, // <!-
		COMMENT: S++, // <!--
		COMMENT_ENDING: S++, // <!-- blah -
		COMMENT_ENDED: S++, // <!-- blah --
		CDATA: S++, // <![CDATA[ something
		CDATA_ENDING: S++, // ]
		CDATA_ENDING_2: S++, // ]]
		PROCESSING_INSTRUCTION: S++, // <?hi
		PROCESSING_INSTRUCTION_BODY: S++, // <?hi there
		PROCESSING_INSTRUCTION_ENDING: S++, // <?hi "there" ?
		OPEN_TAG: S++, // <strong
		OPEN_TAG_SLASH: S++, // <strong /
		ATTRIBUTE: S++, // <a
		ATTRIBUTE_NAME: S++, // <a foo
		ATTRIBUTE_NAME_SAW_WHITE: S++, // <a foo _
		ATTRIBUTE_VALUE: S++, // <a foo=
		ATTRIBUTE_VALUE_QUOTED: S++, // <a foo="bar
		ATTRIBUTE_VALUE_CLOSED: S++, // <a foo="bar"
		ATTRIBUTE_VALUE_UNQUOTED: S++, // <a foo=bar
		ATTRIBUTE_VALUE_ENTITY_QUOTED: S++, // <foo bar="&quot;"
		ATTRIBUTE_VALUE_ENTITY_UNQUOTED: S++, // <foo bar=&quot
		CLOSE_TAG: S++, // </a
		CLOSE_TAG_SAW_WHITE: S++, // </a   >
		SCRIPT: S++, // <script> ...
		SCRIPT_ENDING: S++, // <script> ... <
	};

	sax.XML_PREDEFINED_ENTITIES = {
		amp: "&",
		gt: ">",
		lt: "<",
		quot: '"',
		apos: "'",
	};

	sax.ENTITIES = {
		amp: "&",
		gt: ">",
		lt: "<",
		quot: '"',
		apos: "'",
		AElig: 198,
		Aacute: 193,
		Acirc: 194,
		Agrave: 192,
		Aring: 197,
		Atilde: 195,
		Auml: 196,
		Ccedil: 199,
		ETH: 208,
		Eacute: 201,
		Ecirc: 202,
		Egrave: 200,
		Euml: 203,
		Iacute: 205,
		Icirc: 206,
		Igrave: 204,
		Iuml: 207,
		Ntilde: 209,
		Oacute: 211,
		Ocirc: 212,
		Ograve: 210,
		Oslash: 216,
		Otilde: 213,
		Ouml: 214,
		THORN: 222,
		Uacute: 218,
		Ucirc: 219,
		Ugrave: 217,
		Uuml: 220,
		Yacute: 221,
		aacute: 225,
		acirc: 226,
		aelig: 230,
		agrave: 224,
		aring: 229,
		atilde: 227,
		auml: 228,
		ccedil: 231,
		eacute: 233,
		ecirc: 234,
		egrave: 232,
		eth: 240,
		euml: 235,
		iacute: 237,
		icirc: 238,
		igrave: 236,
		iuml: 239,
		ntilde: 241,
		oacute: 243,
		ocirc: 244,
		ograve: 242,
		oslash: 248,
		otilde: 245,
		ouml: 246,
		szlig: 223,
		thorn: 254,
		uacute: 250,
		ucirc: 251,
		ugrave: 249,
		uuml: 252,
		yacute: 253,
		yuml: 255,
		copy: 169,
		reg: 174,
		nbsp: 160,
		iexcl: 161,
		cent: 162,
		pound: 163,
		curren: 164,
		yen: 165,
		brvbar: 166,
		sect: 167,
		uml: 168,
		ordf: 170,
		laquo: 171,
		not: 172,
		shy: 173,
		macr: 175,
		deg: 176,
		plusmn: 177,
		sup1: 185,
		sup2: 178,
		sup3: 179,
		acute: 180,
		micro: 181,
		para: 182,
		middot: 183,
		cedil: 184,
		ordm: 186,
		raquo: 187,
		frac14: 188,
		frac12: 189,
		frac34: 190,
		iquest: 191,
		times: 215,
		divide: 247,
		OElig: 338,
		oelig: 339,
		Scaron: 352,
		scaron: 353,
		Yuml: 376,
		fnof: 402,
		circ: 710,
		tilde: 732,
		Alpha: 913,
		Beta: 914,
		Gamma: 915,
		Delta: 916,
		Epsilon: 917,
		Zeta: 918,
		Eta: 919,
		Theta: 920,
		Iota: 921,
		Kappa: 922,
		Lambda: 923,
		Mu: 924,
		Nu: 925,
		Xi: 926,
		Omicron: 927,
		Pi: 928,
		Rho: 929,
		Sigma: 931,
		Tau: 932,
		Upsilon: 933,
		Phi: 934,
		Chi: 935,
		Psi: 936,
		Omega: 937,
		alpha: 945,
		beta: 946,
		gamma: 947,
		delta: 948,
		epsilon: 949,
		zeta: 950,
		eta: 951,
		theta: 952,
		iota: 953,
		kappa: 954,
		lambda: 955,
		mu: 956,
		nu: 957,
		xi: 958,
		omicron: 959,
		pi: 960,
		rho: 961,
		sigmaf: 962,
		sigma: 963,
		tau: 964,
		upsilon: 965,
		phi: 966,
		chi: 967,
		psi: 968,
		omega: 969,
		thetasym: 977,
		upsih: 978,
		piv: 982,
		ensp: 8194,
		emsp: 8195,
		thinsp: 8201,
		zwnj: 8204,
		zwj: 8205,
		lrm: 8206,
		rlm: 8207,
		ndash: 8211,
		mdash: 8212,
		lsquo: 8216,
		rsquo: 8217,
		sbquo: 8218,
		ldquo: 8220,
		rdquo: 8221,
		bdquo: 8222,
		dagger: 8224,
		Dagger: 8225,
		bull: 8226,
		hellip: 8230,
		permil: 8240,
		prime: 8242,
		Prime: 8243,
		lsaquo: 8249,
		rsaquo: 8250,
		oline: 8254,
		frasl: 8260,
		euro: 8364,
		image: 8465,
		weierp: 8472,
		real: 8476,
		trade: 8482,
		alefsym: 8501,
		larr: 8592,
		uarr: 8593,
		rarr: 8594,
		darr: 8595,
		harr: 8596,
		crarr: 8629,
		lArr: 8656,
		uArr: 8657,
		rArr: 8658,
		dArr: 8659,
		hArr: 8660,
		forall: 8704,
		part: 8706,
		exist: 8707,
		empty: 8709,
		nabla: 8711,
		isin: 8712,
		notin: 8713,
		ni: 8715,
		prod: 8719,
		sum: 8721,
		minus: 8722,
		lowast: 8727,
		radic: 8730,
		prop: 8733,
		infin: 8734,
		ang: 8736,
		and: 8743,
		or: 8744,
		cap: 8745,
		cup: 8746,
		int: 8747,
		there4: 8756,
		sim: 8764,
		cong: 8773,
		asymp: 8776,
		ne: 8800,
		equiv: 8801,
		le: 8804,
		ge: 8805,
		sub: 8834,
		sup: 8835,
		nsub: 8836,
		sube: 8838,
		supe: 8839,
		oplus: 8853,
		otimes: 8855,
		perp: 8869,
		sdot: 8901,
		lceil: 8968,
		rceil: 8969,
		lfloor: 8970,
		rfloor: 8971,
		lang: 9001,
		rang: 9002,
		loz: 9674,
		spades: 9824,
		clubs: 9827,
		hearts: 9829,
		diams: 9830,
	};

	Object.keys(sax.ENTITIES).forEach((key) => {
		var e = sax.ENTITIES[key];
		var s = typeof e === "number" ? String.fromCharCode(e) : e;
		sax.ENTITIES[key] = s;
	});

	for (var s in sax.STATE) {
		sax.STATE[sax.STATE[s]] = s;
	}

	// shorthand
	S = sax.STATE;

	function emit(this, event, data) {
		this[event] && this[event](data);
	}

	function emitNode(this, nodeType, data) {
		if (this.textNode) closeText(this);
		emit(this, nodeType, data);
	}

	function closeText(this): void {
		this.textNode = applyTextOptions(this.options, this.textNode);
		if (this.textNode) emit(this, "onText", this.textNode);
		this.textNode = "";
	}

	function applyTextOptions(options, text: string): string {
		if (options.trim) text = text.trim();
		if (options.normalize) text = text.replace(/\s+/g, " ");
		return text;
	}

	function fail(this, error: string) {
		closeText(this);

		if (this.trackPosition) {
			error +=
				"\nLine: " +
				this.line +
				"\nColumn: " +
				this.column +
				"\nChar: " +
				this.c;
		}

		error = new Error(error);
		this.error = error;
		emit(this, "onError", error);
		return this;
	}

	function end(this) {
		if (this.hasSeenRoot && !this.closedRoot)
			strictFail(this, "Unclosed root tag");
		if (
			this.state !== State.BEGIN &&
			this.state !== State.BEGIN_WHITESPACE &&
			this.state !== State.TEXT
		) {
			fail(this, "Unexpected end");
		}
		closeText(this);
		this.char = "";
		this.closed = true;
		emit(this, "onEnd");
		SAXParser.call(this, this.strict, this.options);
		return this;
	}

	function strictFail(this, message) {
		if (typeof this !== "object" || !(this instanceof SAXParser)) {
			throw new Error("bad call to strictFail");
		}
		if (this.strict) {
			fail(this, message);
		}
	}

	function newTag(this) {
		if (!this.strict) this.tagName = this.tagName[this.caseTransform]();

		var parent = this.tags[this.tags.length - 1] || this;

		var tag = (this.tag = { name: this.tagName, attributes: {} });

		// will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
		if (this.options.namespaces) {
			tag.ns = parent.ns;
		}
		this.attributeList.length = 0;
		emitNode(this, "onOpenTagStart", tag);
	}

	function getQName(name: string, isAttribute = false) {
		var i = name.indexOf(":");
		var qName = i < 0 ? ["", name] : name.split(":");
		var prefix = qName[0];
		var localName = qName[1];

		// <x "xmlns"="http://foo">
		if (isAttribute && name === "xmlns") {
			prefix = "xmlns";
			localName = "";
		}

		return { prefix, localName };
	}

	function processAttribute(this): void {
		if (!this.strict) {
			this.attributeName = this.attributeName[this.caseTransform]();
		}

		if (
			this.attributeList.indexOf(this.attributeName) !== -1 ||
			this.tag.attributes.hasOwnProperty(this.attributeName)
		) {
			this.attributeName = this.attributeValue = "";
			return;
		}

		if (this.options.namespaces) {
			var qName = getQName(this.attributeName, true);
			var prefix = qName.prefix;
			var localName = qName.localName;

			if (prefix === "xmlns") {
				// namespace binding attribute. push the binding into scope
				if (localName === "xml" && this.attributeValue !== NAMESPACES.xml) {
					strictFail(
						this,
						"xml: prefix must be bound to " +
							NAMESPACES.xml +
							"\n" +
							"Actual: " +
							this.attributeValue,
					);
				} else if (
					localName === "xmlns" &&
					this.attributeValue !== NAMESPACES.xmlns
				) {
					strictFail(
						this,
						"xmlns: prefix must be bound to " +
							NAMESPACES.xmlns +
							"\n" +
							"Actual: " +
							this.attributeValue,
					);
				} else {
					var tag = this.tag;
					var parent = this.tags[this.tags.length - 1] || this;

					if (tag.ns === parent.ns) {
						tag.ns = Object.create(parent.ns);
					}

					tag.ns[localName] = this.attributeValue;
				}
			}

			// defer onattribute events until all attributes have been seen
			// so any new bindings can take effect. preserve attribute order
			// so deferred events can be emitted in document order
			this.attributeList.push([this.attributeName, this.attributeValue]);
		} else {
			// in non-xmlns mode, we can emit the event right away
			this.tag.attributes[this.attributeName] = this.attributeValue;
			emitNode(this, "onAttribute", {
				name: this.attributeName,
				value: this.attributeValue,
			});
		}

		this.attributeName = this.attributeValue = "";
	}

	function openTag(parser, selfClosing?: boolean): void {
		if (parser.options.namespaces) {
			const tag = parser.tag;
			const qName = getQName(parser.tagName);

			tag.prefix = qName.prefix;
			tag.localName = qName.localName;
			tag.uri = tag.ns[qName.prefix] ?? "";

			if (tag.prefix && !tag.uri) {
				strictFail(
					parser,
					"Unbound namespace prefix: " + JSON.stringify(parser.tagName),
				);
				tag.uri = qName.prefix;
			}

			var parent = parser.tags[this.tags.length - 1] || parser;

			if (tag.ns && parent.ns !== tag.ns) {
				Object.keys(tag.ns).forEach((prefix) => {
					emitNode(parser, "onOpenNamespace", {
						prefix,
						uri: tag.ns[prefix],
					});
				});
			}

			// handle deferred onattribute events
			// Note: do not apply default ns to attributes:
			//   http://www.w3.org/TR/REC-xml-names/#defaulting
			for (var i = 0, l = parser.attributeList.length; i < l; i++) {
				var nv = parser.attributeList[i];
				var name = nv[0];
				var value = nv[1];
				var qName = getQName(name, true);
				var prefix = qName.prefix;
				var localName = qName.localName;
				var uri = prefix === "" ? "" : tag.ns[prefix] || "";

				var attribute = {
					name,
					value,
					prefix,
					localName,
					uri,
				};

				// if there's any attributes with an undefined namespace,
				// then fail on them now.
				if (prefix && prefix !== "xmlns" && !uri) {
					strictFail(
						parser,
						"Unbound namespace prefix: " + JSON.stringify(prefix),
					);
					attribute.uri = prefix;
				}
				parser.tag.attributes[name] = attribute;
				emitNode(parser, "onAttribute", attribute);
			}

			parser.attributeList.length = 0;
		}

		parser.tag.isSelfClosing = !!selfClosing;

		// process the tag
		parser.hasSeenRoot = true;
		parser.tags.push(parser.tag);

		emitNode(parser, "onOpenTag", parser.tag);

		if (!selfClosing) {
			// special case for <script> in non-strict mode.
			if (!parser.noScript && parser.tagName.toLowerCase() === "script") {
				parser.state = State.SCRIPT;
			} else {
				parser.state = State.TEXT;
			}
			parser.tag = null;
			parser.tagName = "";
		}
		parser.attributeName = parser.attributeValue = "";
		parser.attributeList.length = 0;
	}

	function closeTag(parser): void {
		if (!parser.tagName) {
			strictFail(parser, "Weird empty close tag.");
			parser.textNode += "</>";
			parser.state = State.TEXT;
			return;
		}

		if (parser.script) {
			if (parser.tagName !== "script") {
				parser.script += "</" + parser.tagName + ">";
				parser.tagName = "";
				parser.state = State.SCRIPT;
				return;
			}
			emitNode(parser, "onScript", parser.script);
			parser.script = "";
		}

		// first make sure that the closing tag actually exists.
		// <a><b></c></b></a> will close everything, otherwise.
		let t = parser.tags.length;
		let tagName = parser.tagName;
		if (!parser.strict) {
			tagName = tagName[parser.caseTransform]();
		}

		const closeTo = tagName;

		while (t--) {
			const close = parser.tags[t];
			if (close.name !== closeTo) {
				// fail the first time in strict mode
				strictFail(parser, "Unexpected close tag");
			} else {
				break;
			}
		}

		// didn't find it.  we already failed for strict, so just abort.
		if (t < 0) {
			strictFail(parser, "Unmatched closing tag: " + parser.tagName);
			parser.textNode += "</" + parser.tagName + ">";
			parser.state = State.TEXT;
			return;
		}
		parser.tagName = tagName;
		var s = parser.tags.length;
		while (s-- > t) {
			var tag = (parser.tag = parser.tags.pop());
			parser.tagName = parser.tag.name;
			emitNode(parser, "onCloseTag", parser.tagName);

			var x = {};
			for (var i in tag.ns) {
				x[i] = tag.ns[i];
			}

			var parent = parser.tags[parser.tags.length - 1] || parser;
			if (parser.options.xmlns && tag.ns !== parent.ns) {
				// remove namespace bindings introduced by tag
				Object.keys(tag.ns).forEach((p) => {
					var n = tag.ns[p];
					emitNode(parser, "onCloseNamespace", { prefix: p, uri: n });
				});
			}
		}
		if (t === 0) parser.closedRoot = true;
		parser.tagName = parser.attributeValue = parser.attributeName = "";
		parser.attributeList.length = 0;
		parser.state = State.TEXT;
	}

	function parseEntity(parser) {
		var entity = parser.entity;
		var entityLC = entity.toLowerCase();
		var number;
		var numStr = "";

		if (parser.ENTITIES[entity]) {
			return parser.ENTITIES[entity];
		}

		if (parser.ENTITIES[entityLC]) {
			return parser.ENTITIES[entityLC];
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
			strictFail(parser, "Invalid character entity");
			return "&" + parser.entity + ";";
		}

		return String.fromCodePoint(number);
	}

	function beginWhitespace(parser, char: string): void {
		if (char === "<") {
			parser.state = State.OPEN_WAKA;
			parser.startTagPosition = parser.position;
		} else if (!isWhitespace(char)) {
			// have to process this as a text node.
			// weird, but happens.
			strictFail(parser, "Non-whitespace before first tag.");
			parser.textNode = char;
			parser.state = State.TEXT;
		}
	}

	function charAt(chunk, i): string {
		var result = "";
		if (i < chunk.length) {
			result = chunk.charAt(i);
		}
		return result;
	}

	function write(chunk) {
		if (this.error) {
			throw this.error;
		}
		if (this.closed) {
			return fail(this, "Cannot write after close. Assign an onready handler.");
		}
		if (chunk === null) {
			return end(this);
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
					this.line++;
					this.column = 0;
				} else {
					this.column++;
				}
			}

			switch (this.state) {
				case State.BEGIN:
					this.state = State.BEGIN_WHITESPACE;
					if (char === "\uFEFF") {
						continue;
					}
					beginWhitespace(this, char);
					continue;

				case State.BEGIN_WHITESPACE:
					beginWhitespace(this, char);
					continue;

				case State.TEXT:
					if (this.hasSeenRoot && !this.closedRoot) {
						var startIndex = i - 1;
						while (char && char !== "<" && char !== "&") {
							char = charAt(chunk, i++);
							if (char && this.trackPosition) {
								this.position++;
								if (char === "\n") {
									this.line++;
									this.column = 0;
								} else {
									this.column++;
								}
							}
						}
						this.textNode += chunk.substring(startIndex, i - 1);
					}
					if (
						char === "<" &&
						!(this.hasSeenRoot && this.closedRoot && !this.strict)
					) {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
					} else {
						if (!isWhitespace(char) && (!this.hasSeenRoot || this.closedRoot)) {
							strictFail(this, "Text data outside of root node.");
						}
						if (char === "&") {
							this.state = State.TEXT_ENTITY;
						} else {
							this.textNode += char;
						}
					}
					continue;

				case State.SCRIPT:
					// only non-strict
					if (char === "<") {
						this.state = State.SCRIPT_ENDING;
					} else {
						this.script += char;
					}
					continue;

				case State.SCRIPT_ENDING:
					if (char === "/") {
						this.state = State.CLOSE_TAG;
					} else {
						this.script += "<" + char;
						this.state = State.SCRIPT;
					}
					continue;

				case State.OPEN_WAKA: {
					// either a /, ?, !, or text is coming next.
					if (char === "!") {
						this.state = State.SGML_DECL;
						this.sgmlDecl = "";
					} else if (isWhitespace(char)) {
						// wait for it...
					} else if (isMatch(REGEX.NAME_START, char)) {
						this.state = State.OPEN_TAG;
						this.tagName = char;
					} else if (char === "/") {
						this.state = State.CLOSE_TAG;
						this.tagName = "";
					} else if (char === "?") {
						this.state = State.PROCESSING_INSTRUCTION;
						this.procInstName = this.procInstBody = "";
					} else {
						strictFail(this, "Unencoded <");
						// if there was some whitespace, then add that in.
						if (this.startTagPosition + 1 < this.position) {
							var pad = this.position - this.startTagPosition;
							char = new Array(pad).join(" ") + char;
						}
						this.textNode += "<" + char;
						this.state = State.TEXT;
					}
					continue;
				}

				case State.SGML_DECL: {
					if (this.sgmlDecl + char === "--") {
						this.state = State.COMMENT;
						this.comment = "";
						this.sgmlDecl = "";
						continue;
					}

					if (this.doctype && this.doctype !== true && this.sgmlDecl) {
						this.state = State.DOCTYPE_DTD;
						this.doctype += "<!" + this.sgmlDecl + char;
						this.sgmlDecl = "";
					} else if ((this.sgmlDecl + char).toUpperCase() === CDATA) {
						emitNode(this, "onOpenCdata");
						this.state = State.CDATA;
						this.sgmlDecl = "";
						this.cdata = "";
					} else if ((this.sgmlDecl + char).toUpperCase() === DOCTYPE) {
						this.state = State.DOCTYPE;
						if (this.doctype || this.hasSeenRoot) {
							strictFail(this, "Inappropriately located doctype declaration");
						}
						this.doctype = "";
						this.sgmlDecl = "";
					} else if (char === ">") {
						this.emitNode(this, "onsgmldeclaration", this.sgmlDecl);
						this.sgmlDecl = "";
						this.state = State.TEXT;
					} else if (isQuote(char)) {
						this.state = State.SGML_DECL_QUOTED;
						this.sgmlDecl += char;
					} else {
						this.sgmlDecl += char;
					}
					continue;
				}

				case State.SGML_DECL_QUOTED: {
					if (char === this.quoteChar) {
						this.state = State.SGML_DECL;
						this.quoteChar = "";
					}
					this.sgmlDecl += char;
					continue;
				}

				case State.DOCTYPE: {
					if (char === ">") {
						this.state = State.TEXT;
						emitNode(this, "ondoctype", this.doctype);
						this.doctype = true; // just remember that we saw it.
					} else {
						this.doctype += char;
						if (char === "[") {
							this.state = State.DOCTYPE_DTD;
						} else if (isQuote(char)) {
							this.state = State.DOCTYPE_QUOTED;
							this.quoteChar = char;
						}
					}
					continue;
				}

				case State.DOCTYPE_QUOTED: {
					this.doctype += char;
					if (char === this.quoteChar) {
						this.quoteChar = "";
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
						this.quoteChar = char;
					} else {
						this.doctype += char;
					}
					continue;
				}

				case State.DOCTYPE_DTD_QUOTED: {
					this.doctype += char;
					if (char === this.quoteChar) {
						this.state = State.DOCTYPE_DTD;
						this.quoteChar = "";
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
						this.comment = applyTextOptions(this.options, this.comment);
						if (this.comment) {
							emitNode(this, "onComment", this.comment);
						}
						this.comment = "";
					} else {
						this.comment += "-" + char;
						this.state = State.COMMENT;
					}
					continue;
				}

				case State.COMMENT_ENDED: {
					if (char !== ">") {
						this.strictFail(this, "Malformed comment");
						// allow <!-- blah -- bloo --> in non-strict mode,
						// which is a comment of " blah -- bloo "
						this.comment += "--" + char;
						this.state = State.COMMENT;
					} else if (this.doctype && this.doctype !== true) {
						this.state = State.DOCTYPE_DTD;
					} else {
						this.state = State.TEXT;
					}
					continue;
				}

				case State.CDATA: {
					var startIndex = i - 1;
					while (char && char !== "]") {
						char = charAt(chunk, i++);
						if (char && this.trackPosition) {
							this.position++;
							if (char === "\n") {
								this.line++;
								this.column = 0;
							} else {
								this.column++;
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
						this.cdata += "]" + char;
						this.state = State.CDATA;
					}
					continue;
				}

				case State.CDATA_ENDING_2: {
					if (char === ">") {
						if (this.cdata) {
							emitNode(this, "onCdata", this.cdata);
						}
						emitNode(this, "onCloseCdata");
						this.cdata = "";
						this.state = State.TEXT;
					} else if (char === "]") {
						this.cdata += "]";
					} else {
						this.cdata += "]]" + char;
						this.state = State.CDATA;
					}
					continue;
				}

				case State.PROCESSING_INSTRUCTION:
					if (char === "?") {
						this.state = State.PROCESSING_INSTRUCTION_ENDING;
					} else if (isWhitespace(char)) {
						this.state = State.PROCESSING_INSTRUCTION_BODY;
					} else {
						this.procInstName += char;
					}
					continue;

				case State.PROCESSING_INSTRUCTION_BODY:
					if (!this.procInstBody && isWhitespace(char)) {
						continue;
					} else if (char === "?") {
						this.state = State.PROCESSING_INSTRUCTION_ENDING;
					} else {
						this.procInstBody += char;
					}
					continue;

				case State.PROCESSING_INSTRUCTION_ENDING: {
					if (char === ">") {
						emitNode(this, "onProcessingInstruction", {
							name: this.procInstName,
							body: this.procInstBody,
						});
						this.procInstName = this.procInstBody = "";
						this.state = State.TEXT;
					} else {
						this.procInstBody += "?" + char;
						this.state = State.PROCESSING_INSTRUCTION_BODY;
					}
					continue;
				}

				case State.OPEN_TAG:
					if (isMatch(REGEX.NAME_BODY, char)) {
						this.tagName += char;
					} else {
						newTag(this);
						if (char === ">") {
							openTag(this);
						} else if (char === "/") {
							this.state = State.OPEN_TAG_SLASH;
						} else {
							if (!isWhitespace(char)) {
								strictFail(this, "Invalid character in tag name");
							}
							this.state = State.ATTRIBUTE;
						}
					}
					continue;

				case State.OPEN_TAG_SLASH:
					if (char === ">") {
						openTag(this, true);
						closeTag(this);
					} else {
						strictFail(this, "Forward-slash in opening tag not followed by >");
						this.state = State.ATTRIBUTE;
					}
					continue;

				case State.ATTRIBUTE:
					// haven't read the attribute name yet.
					if (isWhitespace(char)) {
						continue;
					} else if (char === ">") {
						openTag(this);
					} else if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
					} else if (isMatch(REGEX.NAME_START, char)) {
						this.attributeName = char;
						this.attributeValue = "";
						this.state = State.ATTRIBUTE_NAME;
					} else {
						strictFail(this, "Invalid attribute name");
					}
					continue;

				case State.ATTRIBUTE_NAME:
					if (char === "=") {
						this.state = State.ATTRIBUTE_VALUE;
					} else if (char === ">") {
						strictFail(this, "Attribute without value");
						this.attributeValue = this.attributeName;
						processAttribute(this);
						openTag(this);
					} else if (isWhitespace(char)) {
						this.state = State.ATTRIBUTE_NAME_SAW_WHITE;
					} else if (isMatch(REGEX.NAME_BODY, char)) {
						this.attributeName += char;
					} else {
						strictFail(this, "Invalid attribute name");
					}
					continue;

				case State.ATTRIBUTE_NAME_SAW_WHITE:
					if (char === "=") {
						this.state = State.ATTRIBUTE_VALUE;
					} else if (isWhitespace(char)) {
						continue;
					} else {
						strictFail(this, "Attribute without value");
						this.tag.attributes[this.attributeName] = "";
						this.attributeValue = "";
						emitNode(this, "onattribute", {
							name: this.attributeName,
							value: "",
						});
						this.attributeName = "";
						if (char === ">") {
							openTag(this);
						} else if (isMatch(REGEX.NAME_START, char)) {
							this.attributeName = char;
							this.state = State.ATTRIBUTE_NAME;
						} else {
							strictFail(this, "Invalid attribute name");
							this.state = State.ATTRIBUTE;
						}
					}
					continue;

				case State.ATTRIBUTE_VALUE:
					if (isWhitespace(char)) {
						continue;
					} else if (isQuote(char)) {
						this.quoteChar = char;
						this.state = State.ATTRIBUTE_VALUE_QUOTED;
					} else {
						if (!this.options.unquotedAttributeValues) {
							fail(this, "Unquoted attribute value");
						}
						this.state = State.ATTRIBUTE_VALUE_UNQUOTED;
						this.attributeValue = char;
					}
					continue;

				case State.ATTRIBUTE_VALUE_QUOTED:
					if (char !== this.quoteChar) {
						if (char === "&") {
							this.state = State.ATTRIBUTE_VALUE_ENTITY_QUOTED;
						} else {
							this.attributeValue += char;
						}
						continue;
					}
					processAttribute(this);
					this.quoteChar = "";
					this.state = State.ATTRIBUTE_VALUE_CLOSED;
					continue;

				case State.ATTRIBUTE_VALUE_CLOSED:
					if (isWhitespace(char)) {
						this.state = State.ATTRIBUTE;
					} else if (char === ">") {
						openTag(this);
					} else if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
					} else if (isMatch(REGEX.NAME_START, char)) {
						strictFail(this, "No whitespace between attributes");
						this.attributeName = char;
						this.attributeValue = "";
						this.state = State.ATTRIBUTE_NAME;
					} else {
						strictFail(this, "Invalid attribute name");
					}
					continue;

				case State.ATTRIBUTE_VALUE_UNQUOTED: {
					if (!isAttributeEnd(char)) {
						if (char === "&") {
							this.state = State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED;
						} else {
							this.attributeValue += char;
						}
						continue;
					}
					processAttribute(parser);
					if (char === ">") {
						openTag(parser);
					} else {
						this.state = State.ATTRIBUTE;
					}
					continue;
				}

				case State.CLOSE_TAG:
					if (!this.tagName) {
						if (isWhitespace(char)) {
							continue;
						} else if (!isMatch(REGEX.NAME_START, char)) {
							if (this.script) {
								this.script += "</" + char;
								this.state = State.SCRIPT;
							} else {
								strictFail(parser, "Invalid tagname in closing tag.");
							}
						} else {
							this.tagName = char;
						}
					} else if (char === ">") {
						closeTag(this);
					} else if (isMatch(REGEX.NAME_BODY, char)) {
						this.tagName += char;
					} else if (this.script) {
						this.script += "</" + this.tagName + char;
						this.tagName = "";
						this.state = State.SCRIPT;
					} else {
						if (!isWhitespace(char)) {
							strictFail(this, "Invalid tagname in closing tag");
						}
						this.state = State.CLOSE_TAG_SAW_WHITE;
					}
					continue;

				case State.CLOSE_TAG_SAW_WHITE: {
					if (isWhitespace(char)) {
						continue;
					}
					if (char === ">") {
						closeTag(this);
					} else {
						strictFail(this, "Invalid characters in closing tag");
					}
					continue;
				}

				case State.TEXT_ENTITY:
				case State.ATTRIBUTE_VALUE_ENTITY_QUOTED:
				case State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED:
					let returnState;
					let buffer;

					switch (this.state) {
						case State.TEXT_ENTITY:
							returnState = State.TEXT;
							buffer = "textNode";
							break;

						case State.ATTRIBUTE_VALUE_ENTITY_QUOTED:
							returnState = State.ATTRIBUTE_VALUE_QUOTED;
							buffer = "attributeValue";
							break;

						case State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED:
							returnState = State.ATTRIBUTE_VALUE_UNQUOTED;
							buffer = "attributeValue";
							break;
					}

					if (char === ";") {
						var parsedEntity = parseEntity(this);

						if (
							this.options.unparsedEntities &&
							!Object.values(sax.XML_PREDEFINED_ENTITIES).includes(parsedEntity)
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
						strictFail(this, "Invalid character in entity name");
						this[buffer] += "&" + this.entity + char;
						this.entity = "";
						this.state = returnState;
					}

					continue;

				default: /* istanbul ignore next */ {
					throw new Error(this, "Unknown state: " + this.state);
				}
			}
		} // while

		if (this.position >= this.bufferCheckPosition) {
			checkBufferLength(this);
		}
		return this;
	}

	/*! http://mths.be/fromcodepoint v0.1.0 by @mathias */
	/* istanbul ignore next */
	if (!String.fromCodePoint) {
		(() => {
			var stringFromCharCode = String.fromCharCode;
			var floor = Math.floor;
			var fromCodePoint = function () {
				var MAX_SIZE = 0x4000;
				var codeUnits = [];
				var highSurrogate;
				var lowSurrogate;
				var index = -1;
				var length = arguments.length;
				if (!length) {
					return "";
				}
				var result = "";
				while (++index < length) {
					var codePoint = Number(arguments[index]);
					if (
						!Number.isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
						codePoint < 0 || // not a valid Unicode code point
						codePoint > 0x10ffff || // not a valid Unicode code point
						floor(codePoint) !== codePoint // not an integer
					) {
						throw RangeError("Invalid code point: " + codePoint);
					}
					if (codePoint <= 0xffff) {
						// BMP code point
						codeUnits.push(codePoint);
					} else {
						// Astral code point; split in surrogate halves
						// http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
						codePoint -= 0x10000;
						highSurrogate = (codePoint >> 10) + 0xd800;
						lowSurrogate = (codePoint % 0x400) + 0xdc00;
						codeUnits.push(highSurrogate, lowSurrogate);
					}
					if (index + 1 === length || codeUnits.length > MAX_SIZE) {
						result += stringFromCharCode.apply(null, codeUnits);
						codeUnits.length = 0;
					}
				}
				return result;
			};
			if (Object.defineProperty) {
				Object.defineProperty(String, "fromCodePoint", {
					value: fromCodePoint,
					configurable: true,
					writable: true,
				});
			} else {
				String.fromCodePoint = fromCodePoint;
			}
		})();
	}
})(typeof exports === "undefined" ? (this.sax = {}) : exports);

export const MAX_BUFFER_LENGTH = 64 * 1024;

export const NAMESPACES = {
	xml: "http://www.w3.org/XML/1998/namespace",
	xmlns: "http://www.w3.org/2000/xmlns/",
} as const;

export const BUFFERS = [
	"attributeName",
	"attributeValue",
	"cdata",
	"comment",
	"doctype",
	"entity",
	"piBody",
	"piName",
	"sgmlDeclaration",
	"tagName",
	"textNode",
] as const;

export const EVENTS = [
	"attribute",
	"cdata",
	"closeCdata",
	"closeNamespace",
	"closeTag",
	"comment",
	"doctype",
	"end",
	"error",
	"openCdata",
	"openNamespace",
	"openTag",
	"openTagStart",
	"processingInstruction",
	"ready",
	"sgmlDeclaration",
	"text",
] as const;

export enum State {
	ATTRIBUTE, // <a
	ATTRIBUTE_NAME, // <a foo
	ATTRIBUTE_NAME_SAW_WHITE, // <a foo _
	ATTRIBUTE_VALUE, // <a foo=
	ATTRIBUTE_VALUE_CLOSED, // <a foo="bar"
	ATTRIBUTE_VALUE_QUOTED, // <a foo="bar
	ATTRIBUTE_VALUE_UNQUOTED, // <a foo=bar
	BEGIN, // leading byte order mark or whitespace
	BEGIN_WHITESPACE, // leading whitespace
	CDATA, // <![CDATA[ something
	CLOSE_TAG, // </a
	CLOSE_TAG_SAW_WHITE, // </a   >
	COMMENT, // <!--
	COMMENT_ENDED, // <!-- blah --
	COMMENT_ENDING, // <!-- blah -
	DOCTYPE, // <!DOCTYPE
	DOCTYPE_DTD, // <!DOCTYPE "//blah" [ ...
	DOCTYPE_DTD_QUOTED, // <!DOCTYPE "//blah" [ "foo
	DOCTYPE_QUOTED, // <!DOCTYPE "//blah
	OPEN_TAG, // <strong
	OPEN_TAG_SLASH, // <strong /
	PROCESSING_INSTRUCTION, // <?hi
	PROCESSING_INSTRUCTION_BODY, // <?hi there
	PROCESSING_INSTRUCTION_ENDING, // <?hi "there" ?
	TEXT, // general stuff
	TEXT_ENTITY, // &amp and such.
	OPEN_WAKA,
	SGML_DECLARATION,
	SGML_DECLARATION_QUOTED,
	CDATA_ENDING,
	CDATA_ENDING_2,
	ATTRIBUTE_VALUE_ENTITY_UNQUOTED,
	ATTRIBUTE_VALUE_ENTITY_QUOTED,
}

export const REGEX = {
	ENTITY_BODY:
		/[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
	ENTITY_START:
		/[#:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
	NAME_BODY:
		/[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040.\d-]/,
	NAME_START:
		/[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
} as const;

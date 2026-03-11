import type { SAXHandlers, SAXOptions } from "@janustack/sax";

export const options: SAXOptions = {
	namespaces: false,
	strict: false,
	trackPosition: false,
} as const;

export const handlers: SAXHandlers = {
	onAttribute(attribute) {
		Bun.stdout.write(
			`Attribute: ${Bun.inspect(
				{ name: attribute.name, value: attribute.value },
				{ colors: true },
			)}\n`,
		);
	},
	onCdata(cdata) {
		Bun.stdout.write(`Cdata: ${cdata}\n`);
	},
	onCloseTag(name) {
		Bun.stdout.write(`Close Tag: ${name}\n`);
	},
	onComment(comment) {
		/**
		 * Unlike sax-js, Janustack SAX does not provide normalize/trim as parser options.
		 * Whitespace processing is the caller's responsibility.
		 *
		 * @example
		 * ```html
		 * <!--   hello   world   -->
		 * ```
		 *
		 * ```ts
		 * comment
		 *  .replace(/\s+/g, " ") → " hello world "
		 *  .trim()               → "hello world"
		 * ```
		 */
		const normalized = comment.replace(/\s+/g, " ").trim();

		if (normalized) {
			Bun.stdout.write(`Comment: ${normalized}\n`);
		}
	},
	onError(error) {
		console.error(`Error: ${error.message}\n`);
	},
	onOpenTag(tag) {
		Bun.stdout.write(`Open Tag: ${Bun.inspect(tag, { colors: true })}\n`);
	},
	onProcessingInstruction(pi) {
		Bun.stdout.write(
			`Processing Instruction: ${Bun.inspect(pi, { colors: true })}\n`,
		);
	},
	onText(text) {
		const normalized = text.replace(/\s+/g, " ").trim();

		if (normalized) {
			Bun.stdout.write(`Text: ${normalized}\n`);
		}
	},
};

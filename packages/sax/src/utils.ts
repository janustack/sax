export function charAt(input: string, index: number): string {
	var result = "";
	if (index < input.length) {
		result = input.charAt(index);
	}
	return result;
}

export function isWhitespace(char: string): boolean {
	return char === " " || char === "\n" || char === "\r" || char === "\t";
}

export function isQuote(char: string): boolean {
	return char === '"' || char === "'";
}

export function isAttribEnd(char: string): boolean {
	return char === ">" || isWhitespace(char);
}

export function isMatch(regex: RegExp, char: string): boolean {
	return regex.test(char);
}

export function textopts(options, text: string): string {
	if (options.trim) text = text.trim();
	if (options.normalize) text = text.replace(/\s+/g, " ");
	return text;
}

export function notMatch(regex: RegExp, char: string): boolean {
	return !isMatch(regex, char);
}

export function getQName(
	name: string,
	isAttribute: boolean,
): { prefix: string; localName: string } {
	const i = name.indexOf(":");
	const qName = i < 0 ? ["", name] : name.split(":");

	let prefix = qName[0];
	let localName = qName[1];

	// <x "xmlns"="http://foo">
	if (isAttribute && name === "xmlns") {
		prefix = "xmlns";
		localName = "";
	}

	return { prefix, localName };
}

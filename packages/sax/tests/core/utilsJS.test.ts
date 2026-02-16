export function isWhitespace(char: string): boolean {
	return char === " " || char === "\n" || char === "\r" || char === "\t";
}

export function isQuote(char: string): boolean {
	return char === '"' || char === "'";
}

export function isAttributeEnd(char: string): boolean {
	return char === ">" || isWhitespace(char);
}

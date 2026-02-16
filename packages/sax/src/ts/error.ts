export class SAXParserError extends Error {
	public readonly column: number;
	public readonly line: number;

	constructor(column: number, line: number, message: string) {
		super(message);

		this.name = "SAXParserError";

		this.column = column;
		this.line = line;
	}

	override toString(): string {
		return `${this.name}: ${this.message} (line ${this.line}, column ${this.column})`;
	}
}

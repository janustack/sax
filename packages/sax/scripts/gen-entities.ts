export async function generateEntities() {
	const url = "https://html.spec.whatwg.org/entities.json";
	const response = await fetch(url);
	const json = await response.json();

	const XML_PREDEFINED_ENTITIES = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		quot: '"',
	};

	const HTML_NAMED_CHARACTER_ENTITIES: Record<string, string> = {};

	for (const [key, { characters }] of Object.entries(json)) {
		if (!key.endsWith(";")) continue; // skip legacy semicolon-less forms
		const name = key.slice(1, -1); // strip & and ;
		HTML_NAMED_CHARACTER_ENTITIES[name] = characters;
	}

	return `
export const XML_PREDEFINED_ENTITIES = {
${Object.entries(XML_PREDEFINED_ENTITIES)
	.map(([k, v]) => `\t${k}: ${JSON.stringify(v)},`)
	.join("\n")}
};

export const HTML_NAMED_CHARACTER_ENTITIES = {
${Object.entries(HTML_NAMED_CHARACTER_ENTITIES)
	.map(([k, v]) => `\t${k}: ${JSON.stringify(v)},`)
	.join("\n")}
};
`;
}
/*
const results = await generateEntities();
const path = "./entities.ts";
const url = new URL(path, import.meta.url);
Bun.write(url, results);
 */

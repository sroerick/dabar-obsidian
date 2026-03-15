import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	collectBibleUrisFromText,
	extractBibleUriFromText,
	findBibleUriMatchInLine,
	parseBibleUri,
} from "../bible-link-utils";

test("parseBibleUri decodes protocol references", () => {
	assert.equal(parseBibleUri("bible://Genesis%201"), "Genesis 1");
	assert.equal(parseBibleUri("bible:Exodus12:11"), "Exodus12:11");
	assert.equal(parseBibleUri("https://example.com"), null);
});

test("findBibleUriMatchInLine recognizes canonical wiki links", () => {
	const line = "[[bible:Exodus12:11|Exodus 12:11]]";
	const offset = line.indexOf("Exodus 12:11");
	assert.deepEqual(findBibleUriMatchInLine(line, offset), {
		uri: "bible:Exodus12:11",
		start: 0,
		end: line.length,
	});
});

test("findBibleUriMatchInLine recognizes reversed legacy wiki links", () => {
	const line = "[[Exodus 12:11|bible:Exodus12:11]]";
	const offset = line.indexOf("bible:Exodus12:11");
	assert.deepEqual(findBibleUriMatchInLine(line, offset), {
		uri: "bible:Exodus12:11",
		start: 0,
		end: line.length,
	});
});

test("findBibleUriMatchInLine recognizes markdown links and bare links", () => {
	const markdown = "[Exodus 12:11](bible:Exodus12:11)";
	assert.equal(findBibleUriMatchInLine(markdown, markdown.indexOf("bible:"))?.uri, "bible:Exodus12:11");

	const bare = 'See bible:Exodus12:11 for context';
	assert.equal(findBibleUriMatchInLine(bare, bare.indexOf("bible:"))?.uri, "bible:Exodus12:11");
});

test("findBibleUriMatchInLine does not trigger on the first character after a link", () => {
	const line = "[[bible:Exodus12:11|Exodus 12:11]] ";
	assert.equal(findBibleUriMatchInLine(line, line.length - 1), null);
});

test("extractBibleUriFromText trims trailing punctuation", () => {
	assert.equal(extractBibleUriFromText("bible:Exodus12:11,"), "bible:Exodus12:11");
	assert.equal(
		extractBibleUriFromText("[[bible:Exodus12:11|Exodus 12:11]]."),
		"bible:Exodus12:11"
	);
});

test("collectBibleUrisFromText returns unique normalized URIs across formats", () => {
	const input = `
[[bible:Exodus12:11|Exodus 12:11]]
[Exodus 12:11](bible:Exodus12:11)
bible:Exodus12:11.
[[Exodus 12:21|bible:Exodus12:21]]
`;

	assert.deepEqual(collectBibleUrisFromText(input), [
		"bible:Exodus12:11",
		"bible:Exodus12:21",
	]);
});

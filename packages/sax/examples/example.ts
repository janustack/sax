import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import sax from "../src/main.js";

let xml = fs.readFileSync(path.join(__dirname, "test.xml"), "utf8");

var fs = require("node:fs"),
	parser = require("../src/main.js"),
	s;
(strict = parser(true)),
	(loose = parser(false, { trim: true })),
	(inspector = function (event) {
		return function (data) {
			console.error("%s %s %j", this.line + ":" + this.column, ev, data);
		};
	});

sax.EVENTS.forEach((event) {
	loose[`on${event}`] = inspector(event);
})

loose.onend = (
function () {
	console.error("end");
	console.error(loose);
}
)(
// do this in random bits at a time to verify that it works.
function () {
		if (xml) {
			var c = Math.ceil(Math.random() * 1000);
			loose.write(xml.substr(0, c));
			xml = xml.substr(c);
			process.nextTick(arguments.callee);
		} else loose.close();
	}
,
)()

// A deliberately small YAML reader for this repository's contracts.
//
// The structure checks used to grep for `section:` in the file text. That let a
// contract pass while being the wrong type, nested under the wrong parent,
// duplicated, or not valid YAML at all — the marker was present, so the check
// was satisfied. Reading the text as data is the only way those become
// detectable.
//
// This is not a general YAML implementation and must not become one. It accepts
// the subset the contracts use and refuses everything else, so an unsupported
// construct fails the check instead of being silently misread.
//
// Supported: two-space indented mappings, block sequences, inline flow
// sequences of scalars, `key: value` scalars, `#` comments, `>`/`|` block
// scalars, and the scalars true/false/null/integer/quoted or bare string.

const INDENT = 2;

function stripComment(line) {
	let out = "";
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			out += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
		if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
		out += ch;
	}
	return out.replace(/\s+$/, "");
}

function parseScalar(raw, where) {
	const text = raw.trim();
	if (text === "") return "";
	if (text === "null" || text === "~") return null;
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+$/.test(text)) return Number(text);
	if (/^".*"$/.test(text) || /^'.*'$/.test(text)) return text.slice(1, -1);
	if (text.startsWith("[") || text.startsWith("{")) {
		if (!text.endsWith("]") && !text.endsWith("}")) throw new Error(`${where}: unterminated flow collection`);
		if (text.startsWith("{")) throw new Error(`${where}: flow mappings are not supported`);
		const inner = text.slice(1, -1).trim();
		if (inner === "") return [];
		return inner.split(",").map((item, index) => parseScalar(item, `${where}[${index}]`));
	}
	if (/[:]\s/.test(text)) throw new Error(`${where}: ambiguous scalar; quote it`);
	return text;
}

function readBlockScalar(lines, start, parentIndent) {
	const collected = [];
	let index = start;
	while (index < lines.length) {
		const { raw } = lines[index];
		if (raw.trim() === "") { collected.push(""); index++; continue; }
		const indent = raw.length - raw.trimStart().length;
		if (indent <= parentIndent) break;
		collected.push(raw.slice(parentIndent + INDENT));
		index++;
	}
	return { text: collected.join("\n").trim(), next: index };
}

function parseBlock(lines, start, indent) {
	// Decide mapping or sequence from the first meaningful line at this level.
	let index = start;
	let container = null;

	while (index < lines.length) {
		const { raw, number } = lines[index];
		if (raw.trim() === "") { index++; continue; }
		const lineIndent = raw.length - raw.trimStart().length;
		if (lineIndent < indent) break;
		if (lineIndent > indent) throw new Error(`line ${number}: unexpected indentation`);
		if (lineIndent % INDENT !== 0) throw new Error(`line ${number}: indentation must be a multiple of ${INDENT}`);

		const body = stripComment(raw.trim());
		if (body === "") { index++; continue; }
		const where = `line ${number}`;

		if (body.startsWith("- ") || body === "-") {
			if (container === null) container = [];
			if (!Array.isArray(container)) throw new Error(`${where}: sequence item inside a mapping`);
			const rest = body === "-" ? "" : body.slice(2).trim();
			if (rest === "") {
				const nested = parseBlock(lines, index + 1, indent + INDENT);
				container.push(nested.value);
				index = nested.next;
				continue;
			}
			if (/^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/.test(rest)) {
				// A sequence of mappings, written inline on the dash line.
				const synthetic = lines.slice();
				synthetic[index] = { raw: `${" ".repeat(indent + INDENT)}${rest}`, number };
				const nested = parseBlock(synthetic, index, indent + INDENT);
				container.push(nested.value);
				index = nested.next;
				continue;
			}
			container.push(parseScalar(rest, where));
			index++;
			continue;
		}

		const match = body.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/);
		if (!match) throw new Error(`${where}: unsupported line`);
		if (container === null) container = {};
		if (Array.isArray(container)) throw new Error(`${where}: mapping key inside a sequence`);
		const [, key, tail] = match;
		if (Object.hasOwn(container, key)) throw new Error(`${where}: duplicate key ${key}`);
		const value = tail.trim();

		if (value === ">" || value === "|" || value === ">-" || value === "|-") {
			const block = readBlockScalar(lines, index + 1, lineIndent);
			container[key] = block.text;
			index = block.next;
			continue;
		}
		if (value === "") {
			const nested = parseBlock(lines, index + 1, indent + INDENT);
			container[key] = nested.value;
			index = nested.next;
			continue;
		}
		container[key] = parseScalar(value, where);
		index++;
	}

	return { value: container === null ? {} : container, next: index };
}

/** Parse the supported subset, or throw explaining why it was refused. */
export function parseYaml(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n")
		.map((raw, i) => ({ raw, number: i + 1 }))
		.filter(({ raw }) => !/^\s*#/.test(raw) && raw.trim() !== "---");
	const { value, next } = parseBlock(lines, 0, 0);
	for (let i = next; i < lines.length; i++) {
		if (lines[i].raw.trim() !== "") throw new Error(`line ${lines[i].number}: trailing content`);
	}
	return value;
}

/** Read a nested value by path, or undefined. */
export function at(value, ...path) {
	let current = value;
	for (const key of path) {
		if (current === null || typeof current !== "object") return undefined;
		current = current[key];
	}
	return current;
}

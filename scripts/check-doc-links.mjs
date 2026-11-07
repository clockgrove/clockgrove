// Documentation links (Wave 0 plan §15 item 15, issue 838): every repository-relative link in a Markdown
// file of the checkout must reach a file or directory that is in it, and its #anchor must name a
// heading of the target (or of the same file for a bare #anchor) as GitHub renders it. Links with a
// URI scheme (http:, https:, mailto:, ...) or a //host are external and never fetched, so the check
// runs offline. No Markdown file is excluded; an exclusion must be listed here by path with its reason.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const markdown = /\.(?:md|markdown)$/iu;
const blank = (text) => text.replace(/[^\n]/gu, " ");
const codeSpan = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])+?)(?<!`)\1(?!`)/gu;
const indentOf = (text) => /^ */u.exec(text)[0].length;

// Block syntax follows CommonMark 0.31 (§4-§5). HTML block start conditions 1-6 (§4.6) with their
// end condition; an end of undefined means the block ends before a blank line.
const blockTags =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const htmlBlocks = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/iu, /<\/(?:pre|script|style|textarea)>/iu],
  [/^ {0,3}<!--/u, /-->/u],
  [/^ {0,3}<\?/u, /\?>/u],
  [/^ {0,3}<![A-Za-z]/u, />/u],
  [/^ {0,3}<!\[CDATA\[/u, /\]\]>/u],
  [new RegExp(`^ {0,3}</?(?:${blockTags})(?:[ \\t]|/?>|$)`, "iu"), undefined],
];
// Condition 7, a lone complete open or closing tag, which cannot interrupt a paragraph.
const htmlTagLine =
  /^ {0,3}(?:<[A-Za-z][A-Za-z\d-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z\d-]*\s*>)[ \t]*$/u;
const atxHeading = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const thematicBreak = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const fenceOpening = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const definition = /^ {0,3}\[(?!\^)[^\]\n]+\]:/u;

// Tabs in a line's leading indentation and block quote markers count to the next multiple of 4.
function expandIndent(line) {
  const lead = /^[ \t>]*/u.exec(line)[0];
  if (!lead.includes("\t")) return line;
  let expanded = "";
  for (const character of lead)
    expanded += character === "\t" ? " ".repeat(4 - (expanded.length % 4)) : character;
  return expanded + line.slice(lead.length);
}

// A list item marker that opens an item here: the item's content column and how much of the line
// the marker takes. An empty item, or an ordered one not starting at 1, cannot interrupt a
// paragraph; 5 or more spaces after the marker start indented code one column after it.
function listItem(text, paragraph) {
  if (thematicBreak.test(text)) return undefined;
  const marker = /^ {0,3}(?:[-+*]|(\d{1,9})[.)])(?= |$)/u.exec(text);
  if (!marker) return undefined;
  const after = text.slice(marker[0].length);
  const empty = after.trim() === "";
  if (paragraph && (empty || (marker[1] !== undefined && Number(marker[1]) !== 1)))
    return undefined;
  const padding = empty || indentOf(after) > 4 ? 1 : indentOf(after);
  return {
    width: marker[0].length + padding,
    taken: marker[0].length + Math.min(padding, after.length),
  };
}

function interruptsParagraph(text) {
  return (
    /^ {0,3}>/u.test(text) ||
    /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(text) ||
    fenceOpening.test(text) ||
    thematicBreak.test(text) ||
    htmlBlocks.some(([start]) => start.test(text)) ||
    listItem(text, true) !== undefined
  );
}

// The block structure of each line: the width of its container prefix (block quote markers, list
// item markers and their continuation indent), the content after it, and the kind of block that
// content belongs to (blank, code, fence, html, atx, setext, break, definition or text). An atx or
// setext record carries its heading's raw inline text; a setext heading's lines are joined by \n.
// Lazy continuation lines continue a paragraph whose container they do not match.
function blockLines(source) {
  const records = [];
  let open = [];
  let fence;
  let html;
  let paragraph = [];
  for (const line of source.split("\n")) {
    let rest = expandIndent(line);
    let prefix = 0;
    let matched = 0;
    for (const container of open) {
      if (container.quote) {
        const marker = /^ {0,3}> ?/u.exec(rest);
        if (!marker) break;
        rest = rest.slice(marker[0].length);
        prefix += marker[0].length;
      } else if (rest.trim() !== "") {
        if (indentOf(rest) < container.item) break;
        rest = rest.slice(container.item);
        prefix += container.item;
      }
      matched += 1;
    }
    const record = (kind, heading) => records.push({ prefix, content: rest, kind, heading });
    if (matched < open.length) {
      if (paragraph.length > 0 && rest.trim() !== "" && !interruptsParagraph(rest)) {
        paragraph.push(rest);
        record("text");
        continue;
      }
      open = open.slice(0, matched);
      paragraph = [];
      if (fence && fence.depth > matched) fence = undefined;
      if (html && html.depth > matched) html = undefined;
    }
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.marker[0]}{${fence.marker.length},}[ \\t]*$`, "u");
      if (closing.test(rest)) fence = undefined;
      record("fence");
      continue;
    }
    if (html && !(html.end === undefined && rest.trim() === "")) {
      if (html.end?.test(rest)) html = undefined;
      record("html");
      continue;
    }
    html = undefined;
    for (;;) {
      if (indentOf(rest) >= 4) break;
      const quote = /^ {0,3}> ?/u.exec(rest);
      const item = quote ? undefined : listItem(rest, paragraph.length > 0);
      if (!quote && !item) break;
      open.push(quote ? { quote: true } : { item: item.width });
      const taken = quote ? quote[0].length : item.taken;
      rest = rest.slice(taken);
      prefix += taken;
      paragraph = [];
    }
    const previous = paragraph;
    paragraph = [];
    if (rest.trim() === "") {
      record("blank");
      continue;
    }
    if (indentOf(rest) >= 4 && previous.length === 0) {
      record("code");
      continue;
    }
    const opening = indentOf(rest) < 4 && fenceOpening.exec(rest);
    const htmlStart = indentOf(rest) < 4 && htmlBlocks.find(([start]) => start.test(rest));
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { marker: opening[1], depth: open.length };
      record("fence");
    } else if (atxHeading.test(rest)) record("atx", atxHeading.exec(rest)[1] ?? "");
    else if (previous.length > 0 && setextUnderline.test(rest))
      record("setext", previous.map((text) => text.trim()).join("\n"));
    else if (thematicBreak.test(rest)) record("break");
    else if (htmlStart || (previous.length === 0 && htmlTagLine.test(rest))) {
      const end = htmlStart?.[1];
      if (!end?.test(rest)) html = { end, depth: open.length };
      record("html");
    } else if (previous.length === 0 && definition.test(rest)) record("definition");
    else {
      paragraph = [...previous, rest];
      record("text");
    }
  }
  return records;
}

// The source with everything GitHub renders literally (fenced and indented code, code spans, HTML
// comments, escaped brackets and backticks) and container prefixes replaced by spaces, so line
// numbers are kept.
function rendered(records) {
  return records
    .map(
      ({ prefix, content, kind }) =>
        " ".repeat(prefix) + (kind === "code" || kind === "fence" ? blank(content) : content),
    )
    .join("\n")
    .replace(/<!--[\s\S]*?-->/gu, blank)
    .replace(/\\[[\]`]/gu, "  ")
    .replace(codeSpan, blank);
}

// Named character references the check decodes (HTML Living Standard §13.5). Any other name is kept
// as written, as GitHub keeps a name HTML does not define.
const namedReferences = {
  amp: "&",
  apos: "'",
  bdquo: "„",
  bull: "•",
  copy: "©",
  darr: "↓",
  deg: "°",
  divide: "÷",
  emsp: "\u2003",
  ensp: "\u2002",
  ge: "≥",
  gt: ">",
  harr: "↔",
  hellip: "…",
  laquo: "«",
  larr: "←",
  ldquo: "“",
  le: "≤",
  lsaquo: "‹",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  minus: "−",
  nbsp: "\u00a0",
  ndash: "–",
  ne: "≠",
  para: "¶",
  plusmn: "±",
  quot: '"',
  raquo: "»",
  rarr: "→",
  rdquo: "”",
  reg: "®",
  rsaquo: "›",
  rsquo: "’",
  sbquo: "‚",
  sect: "§",
  shy: "\u00ad",
  thinsp: "\u2009",
  times: "×",
  trade: "™",
  uarr: "↑",
};
// The Latin-1 letters (and × ÷ between them) are U+00C0-U+00FF in this order (HTML 4.01 §24.2).
"Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
  .split(" ")
  .forEach((name, index) => {
    namedReferences[name] = String.fromCodePoint(0xc0 + index);
  });
const characterReference = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z][A-Za-z\d]{1,31}));/u;

function decodeReference(reference) {
  const [, decimal, hexadecimal, name] = characterReference.exec(reference);
  if (name !== undefined) return namedReferences[name] ?? reference;
  const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hexadecimal, 16);
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? "\ufffd"
    : String.fromCodePoint(code);
}

const isWhitespace = (character) => /\s/u.test(character);
const isPunctuation = (character) => /[\p{P}\p{S}]/u.test(character);

// Inline text of a heading as GitHub renders it: code span contents (line endings as spaces, one
// space stripped from each side only when both sides have one), link and image text, HTML tags
// removed, backslash escapes and character references resolved, and `*`/`_` delimiter runs removed
// only where they close a matched emphasis pair (CommonMark §6.1-§6.4).
function headingText(raw) {
  const tokens = [];
  raw.split(codeSpan).forEach((part, index) => {
    if (index % 3 === 1) return;
    if (index % 3 === 2) {
      const content = part.replaceAll("\n", " ");
      const stripped = /^ [\s\S]*[^ ][\s\S]* $/u.test(content) ? content.slice(1, -1) : content;
      tokens.push({ text: stripped, source: "`" });
      return;
    }
    const text = part
      .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/gu, "$1")
      .replace(/<\/?[A-Za-z][A-Za-z\d-]*(?:\s[^<>]*)?\/?>/gu, "");
    const pieces = new RegExp(
      `\\\\([!-/:-@[-\`{-~])|${characterReference.source}|(\\*+|_+)|[^\\\\&*_]+|[\\\\&]`,
      "gu",
    );
    for (const match of text.matchAll(pieces)) {
      if (match[1] !== undefined) tokens.push({ text: match[1], source: match[0] });
      else if (match[0].startsWith("&") && match[0].length > 1)
        tokens.push({ text: decodeReference(match[0]), source: match[0] });
      else if (match[5] !== undefined)
        tokens.push({ delimiter: match[5][0], length: match[5].length, source: match[5] });
      else tokens.push({ text: match[0], source: match[0] });
    }
  });
  tokens.forEach((token, index) => {
    if (token.delimiter === undefined) return;
    const before = tokens[index - 1]?.source.at(-1) ?? " ";
    const after = tokens[index + 1]?.source[0] ?? " ";
    const left =
      !isWhitespace(after) &&
      (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
    const right =
      !isWhitespace(before) &&
      (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
    const underscore = token.delimiter === "_";
    token.original = token.length;
    token.opens = left && (!underscore || !right || isPunctuation(before));
    token.closes = right && (!underscore || !left || isPunctuation(after));
  });
  tokens.forEach((closer, index) => {
    if (closer.delimiter === undefined || !closer.closes) return;
    while (closer.length > 0) {
      let at = index - 1;
      for (; at >= 0; at -= 1) {
        const opener = tokens[at];
        if (
          opener.delimiter === closer.delimiter &&
          opener.opens &&
          !opener.removed &&
          opener.length > 0 &&
          !(
            (opener.closes || closer.opens) &&
            (opener.original + closer.original) % 3 === 0 &&
            (opener.original % 3 !== 0 || closer.original % 3 !== 0)
          )
        )
          break;
      }
      if (at < 0) break;
      const used = tokens[at].length >= 2 && closer.length >= 2 ? 2 : 1;
      tokens[at].length -= used;
      closer.length -= used;
      for (let between = at + 1; between < index; between += 1) tokens[between].removed = true;
    }
  });
  return tokens
    .map((token) =>
      token.delimiter === undefined ? token.text : token.delimiter.repeat(token.length),
    )
    .join("");
}

// GitHub's heading id: the heading's rendered text, lowercased, with everything except letters,
// marks, decimal digits, connector punctuation, hyphens and spaces removed, and each space made a
// hyphen (html-pipeline TableOfContentsFilter, /[^\p{Word}\- ]/u). A repeated id takes the first
// free -1, -2, ... after the ones its text already used, skipping ids earlier headings hold.
function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Pc}\- ]/gu, "")
    .replaceAll(" ", "-");
}

function markdownAnchors(source) {
  const records = blockLines(source);
  const text = rendered(records);
  const headings = records.flatMap((record, line) =>
    record.heading === undefined ? [] : [{ line, text: headingText(record.heading) }],
  );
  // Raw HTML <h1>-<h6> elements get ids from their text too.
  for (const match of text.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu))
    headings.push({
      line: text.slice(0, match.index).split("\n").length - 1,
      text: match[2]
        .replace(/<[^>]*>/gu, "")
        .replace(new RegExp(characterReference.source, "gu"), decodeReference),
    });
  headings.sort((left, right) => left.line - right.line);
  const anchors = new Set();
  const seen = new Map();
  for (const heading of headings) {
    const slug = githubSlug(heading.text);
    let count = seen.get(slug) ?? 0;
    let id = count === 0 ? slug : `${slug}-${count}`;
    while (anchors.has(id)) {
      count += 1;
      id = `${slug}-${count}`;
    }
    seen.set(slug, count + 1);
    anchors.add(id);
  }
  for (const [, id] of text.matchAll(/<[a-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/giu))
    anchors.add(id);
  anchors.delete("");
  return anchors;
}

function startsLink(text, close) {
  let depth = 0;
  for (let index = close - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (character === "]") depth += 1;
    if (character === "[" && depth-- === 0) return true;
    if (
      character === "\n" &&
      text.slice(text.lastIndexOf("\n", index - 1) + 1, index).trim() === ""
    )
      return false;
  }
  return false;
}

// The destination of an inline link whose `](` is at `start - 2`, or undefined when it is no link.
function inlineDestination(text, start) {
  let index = start + /^[ \t]*(?:\n[ \t]*)?/u.exec(text.slice(start))[0].length;
  let destination;
  if (text[index] === "<") {
    const end = text.indexOf(">", index);
    if (end < 0 || text.slice(index, end).includes("\n")) return undefined;
    destination = text.slice(index + 1, end);
    index = end + 1;
  } else {
    const from = index;
    for (let depth = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\") index += 1;
      else if (/\s/u.test(character)) break;
      else if (character === "(") depth += 1;
      else if (character === ")" && depth-- === 0) break;
    }
    destination = text.slice(from, index);
  }
  const rest = /^[ \t]*(?:\n[ \t]*)?(?:(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*)?\)/u;
  return rest.test(text.slice(index)) ? destination : undefined;
}

// Inline links and images and reference definitions outside code and HTML blocks, and HTML
// href/src attributes outside code.
function markdownLinks(source) {
  const records = blockLines(source);
  const text = rendered(records);
  const starts = [0];
  for (const { index } of text.matchAll(/\n/gu)) starts.push(index + 1);
  const lineOf = (offset) => {
    let line = 1;
    while (line < starts.length && starts[line] <= offset) line += 1;
    return line;
  };
  const links = [];
  for (const { index } of text.matchAll(/\]\(/gu)) {
    const line = lineOf(index);
    if (records[line - 1].kind === "html") continue;
    const destination = inlineDestination(text, index + 2);
    if (destination !== undefined && startsLink(text, index)) links.push({ line, destination });
  }
  records.forEach((record, index) => {
    if (record.kind !== "definition") return;
    const match = /[ ]*\[[^\]\n]+\]:[ \t]*(?:\n[ \t]*)?(<[^>\n]*>|\S+)/uy;
    match.lastIndex = starts[index];
    const found = match.exec(text);
    if (found) links.push({ line: index + 1, destination: found[1].replace(/^<(.*)>$/u, "$1") });
  });
  for (const match of text.matchAll(
    /<(?:a|img)\b[^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu,
  ))
    links.push({ line: lineOf(match.index), destination: match[1] ?? match[2] });
  return links.sort((left, right) => left.line - right.line);
}

// Problems with the links of every Markdown file in `files` (repository-relative POSIX paths);
// `read` returns a file's text.
export function documentationLinkProblems(files, read) {
  const directories = new Set(["."]);
  for (const file of files)
    for (let parent = path.posix.dirname(file); parent !== "."; parent = path.posix.dirname(parent))
      directories.add(parent);
  const anchors = new Map();
  const anchorsOf = (file) => {
    if (!anchors.has(file)) anchors.set(file, markdownAnchors(read(file)));
    return anchors.get(file);
  };
  const problems = [];
  for (const document of [...files].filter((file) => markdown.test(file)).sort()) {
    for (const { line, destination } of markdownLinks(read(document))) {
      if (destination === "" || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(destination)) continue;
      const report = (reason) =>
        problems.push(`${document}:${line}: link "${destination}" ${reason}`);
      const hash = destination.indexOf("#");
      const [linked, query = ""] = (hash < 0 ? destination : destination.slice(0, hash)).split(
        /\?(.*)/su,
      );
      let target;
      let fragment;
      try {
        target = linked === "" ? document : decodeURIComponent(linked);
        fragment = hash < 0 ? "" : decodeURIComponent(destination.slice(hash + 1));
      } catch {
        report("is not valid percent-encoding");
        continue;
      }
      if (linked !== "")
        target = path.posix.normalize(
          target.startsWith("/")
            ? target.slice(1) || "."
            : path.posix.join(path.posix.dirname(document), target),
        );
      const directory = target.endsWith("/");
      target = target.replace(/(.)\/$/u, "$1");
      if (target === ".." || target.startsWith("../")) {
        report("points outside the repository");
        continue;
      }
      if (!(directories.has(target) || (!directory && files.has(target)))) {
        report(`points to ${target}, which is not in the checkout`);
        continue;
      }
      if (fragment === "") continue;
      // GitHub renders a Markdown file, so its anchors are headings, unless ?plain=1 shows its source.
      const plain = query.split("&").includes("plain=1");
      if (files.has(target) && markdown.test(target) && !plain) {
        if (!anchorsOf(target).has(fragment))
          report(`names #${fragment}, which matches no heading of ${target}`);
        continue;
      }
      const lines = fragment.match(/^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/u);
      const count = files.has(target) ? read(target).split("\n").length : 0;
      if (
        !lines ||
        Number(lines[1]) < 1 ||
        Number(lines[1]) > count ||
        Number(lines[2] ?? 0) > count
      )
        report(`names #${fragment}, which is not a line of ${target}`);
    }
  }
  return problems;
}

export function checkDocumentationLinks(root) {
  const files = new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((name) => name !== "" && existsSync(path.join(root, name))),
  );
  const problems = documentationLinkProblems(files, (file) =>
    readFileSync(path.join(root, file), "utf8"),
  );
  assert.deepEqual(problems, [], problems.join("\n"));
  const documents = [...files].filter((file) => markdown.test(file)).length;
  console.log(`repository links and anchors verified in ${documents} Markdown files`);
}

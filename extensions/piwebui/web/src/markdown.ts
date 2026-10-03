/**
 * Minimal markdown renderer for the file panel.
 *
 * Safety model: every character of the source is HTML-escaped first, and the only tags that can
 * ever appear in the output are the ones this file writes. Links are restricted to http/https/
 * mailto/relative, so a `javascript:` or `data:` URL cannot become clickable. No dependency, and
 * no code path that interpolates raw source into the output.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** Only these URL shapes are allowed to reach an href. */
export function safeHref(url: string): string {
	const trimmed = url.trim();
	if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "#"; // any other scheme (javascript:, data:, …)
	return trimmed; // relative path or fragment
}

function inline(text: string): string {
	let out = escapeHtml(text);
	const codes: string[] = [];
	// code spans are lifted out so emphasis rules cannot touch their contents
	out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
		codes.push(code);
		return `\u0000${codes.length - 1}\u0000`;
	});
	out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string) => `[image: ${alt || "(no alt)"}]`);
	out = out.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_match, label: string, href: string) => `<a href="${safeHref(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`,
	);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)] ?? ""}</code>`);
	return out;
}

interface ListItem {
	indent: number;
	text: string;
	ordered: boolean;
}

function renderList(items: ListItem[]): string {
	if (!items.length) return "";
	let html = "";
	let index = 0;
	const walk = (depth: number): string => {
		const item = items[index];
		const ordered = item.ordered;
		let out = ordered ? "<ol>" : "<ul>";
		while (index < items.length && items[index].indent === depth) {
			const current = items[index];
			index++;
			const nested = index < items.length && items[index].indent > depth ? walk(items[index].indent) : "";
			out += `<li>${inline(current.text)}${nested}</li>`;
		}
		out += ordered ? "</ol>" : "</ul>";
		return out;
	};
	while (index < items.length) html += walk(items[index].indent);
	return html;
}

/** Render markdown to a safe HTML subset. */
export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let html = "";
	let paragraph: string[] = [];
	let list: ListItem[] = [];
	let quote: string[] = [];
	let fence: string[] | null = null;
	let fenceLang = "";

	const flushParagraph = (): void => {
		if (!paragraph.length) return;
		html += `<p>${paragraph.map((line) => inline(line)).join("<br>")}</p>`;
		paragraph = [];
	};
	const flushList = (): void => {
		if (!list.length) return;
		html += renderList(list);
		list = [];
	};
	const flushQuote = (): void => {
		if (!quote.length) return;
		html += `<blockquote>${quote.map((line) => inline(line)).join("<br>")}</blockquote>`;
		quote = [];
	};
	const flushAll = (): void => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (fence) {
			if (/^\s*```/.test(line)) {
				html += `<pre class="md-code"><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
				fence = null;
				fenceLang = "";
			} else {
				fence.push(line);
			}
			continue;
		}

		const fenceStart = line.match(/^\s*```(\w*)\s*$/);
		if (fenceStart) {
			flushAll();
			fence = [];
			fenceLang = fenceStart[1] ?? "";
			continue;
		}

		if (!line.trim()) {
			flushAll();
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushAll();
			const level = heading[1].length;
			html += `<h${level}>${inline(heading[2])}</h${level}>`;
			continue;
		}

		if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
			flushAll();
			html += "<hr>";
			continue;
		}

		// table: a header row followed by a separator row of dashes
		if (line.includes("|") && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] ?? "")) {
			const cell = (row: string): string[] =>
				row
					.replace(/^\s*\|/, "")
					.replace(/\|\s*$/, "")
					.split("|")
					.map((entry) => entry.trim());
			flushAll();
			const head = cell(line);
			html += `<table class="md-table"><thead><tr>${head.map((entry) => `<th>${inline(entry)}</th>`).join("")}</tr></thead><tbody>`;
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
				html += `<tr>${cell(lines[i]).map((entry) => `<td>${inline(entry)}</td>`).join("")}</tr>`;
				i++;
			}
			i--;
			html += "</tbody></table>";
			continue;
		}

		const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
		if (listItem) {
			flushParagraph();
			flushQuote();
			list.push({ indent: Math.floor(listItem[1].length / 2), ordered: /\d/.test(listItem[2]), text: listItem[3] });
			continue;
		}

		const quoted = line.match(/^\s*>\s?(.*)$/);
		if (quoted) {
			flushParagraph();
			flushList();
			quote.push(quoted[1]);
			continue;
		}

		flushList();
		flushQuote();
		paragraph.push(line);
	}

	if (fence) html += `<pre class="md-code"><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
	flushAll();
	return html;
}

/** Markdown renderer: formatting works, and nothing from the source can become markup. */
import { readFileSync } from "node:fs";
import { renderMarkdown, safeHref } from "../web/src/markdown.ts";

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sample = readFileSync(new URL("./fixtures/sample.md", import.meta.url), "utf8");
const html = renderMarkdown(sample);

check("headings render", html.includes("<h1>Title</h1>") && html.includes("<h3>Sub</h3>"));
check("bold/italic/inline code render", html.includes("<strong>bold</strong>") && html.includes("<em>italic</em>") && html.includes("<code>inline()</code>"));
check("fenced code keeps its text and is escaped", html.includes('<pre class="md-code"><code>const x = 1 &lt; 2;') , "code block");
check("lists render, nested included", html.includes("<ul>") && html.includes("<li>first") && html.includes("<ol>") && html.includes("<li>one</li>"));
check("blockquote and rule render", html.includes("<blockquote>quoted</blockquote>") && html.includes("<hr>"));
check("table renders with header cells", html.includes("<th>a</th>") && html.includes("<td>1</td>"));
check("safe links keep http and relative targets", html.includes('href="https://example.com/x"') && html.includes('href="./other.md"'));
check("links are target=_blank with noopener", html.includes('target="_blank" rel="noreferrer noopener"'));
check("images degrade to a placeholder (nothing is fetched)", html.includes("[image: alt text]"));

// injection: raw HTML in the source must never survive as markup
const hostile = renderMarkdown('<script>alert("x")</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))');
check("embedded <script> is escaped", hostile.includes("&lt;script&gt;") && !hostile.includes("<script>"), hostile.slice(0, 60));
check("embedded <img onerror> is escaped", !hostile.includes("<img") && hostile.includes("&lt;img"));
check("javascript: URLs are neutralised", hostile.includes('href="#"') && !hostile.includes("javascript:alert"), "href rewritten");
check("safeHref rejects unknown schemes", safeHref("data:text/html,<b>x</b>") === "#" && safeHref("javascript:x") === "#" && safeHref("https://ok") === "https://ok");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

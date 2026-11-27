import { Marked } from "https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.4.0/dist/purify.es.mjs";

const markdown = new Marked({ gfm: true, breaks: true });

function inlineStyle(name, tag, pattern, delimiter) {
  return {
    name,
    level: "inline",
    start: (source) => source.indexOf(delimiter),
    tokenizer(source) {
      const match = pattern.exec(source);
      if (!match) return;
      return { type: name, raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) {
      return `<${tag}>${this.parser.parseInline(token.tokens)}</${tag}>`;
    }
  };
}

function mathExtension(name, pattern, block) {
  return {
    name,
    level: block ? "block" : "inline",
    start: (source) => source.indexOf(block ? "$$" : "$"),
    tokenizer(source) {
      const match = pattern.exec(source);
      if (match) return { type: name, raw: match[0], text: match[1] };
    },
    renderer(token) {
      return `<code data-math="${block ? "display" : "inline"}">${escapeHtml(token.text)}</code>`;
    }
  };
}

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

markdown.use({
  extensions: [
    inlineStyle("highlight", "mark", /^==([^\n]+?)==/, "=="),
    inlineStyle("underline", "u", /^\+\+([^\n]+?)\+\+/, "++"),
    mathExtension("mathBlock", /^ {0,3}\$\$\s*([\s\S]+?)\s*\$\$[ \t]*(?:\n|$)/, true),
    mathExtension("mathInline", /^\$(?![\s$])((?:\\[^\n]|[^$\\\n])+?)\$(?![\d$])/, false)
  ],
  renderer: {
    code({ text, lang }) {
      if (lang?.trim() === "mermaid") return `<pre><code data-mermaid="">${escapeHtml(text)}</code></pre>`;
      return false;
    },
    html({ text }) {
      return escapeHtml(text);
    }
  }
});

function renderMarkdownToHtml(source) {
  return DOMPurify.sanitize(markdown.parse(source), {
    ALLOWED_TAGS: [
      "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4",
      "h5", "h6", "hr", "img", "input", "li", "mark", "ol", "p", "pre",
      "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul"
    ],
    ALLOWED_ATTR: ["href", "title", "src", "alt", "start", "type", "checked", "disabled"]
  });
}

let katexModule;
let mermaidModule;
let stylesheetInstalled = false;
let nextDiagramId = 0;
const diagramCache = new Map();
const lastRenderedSource = new WeakMap();

export function renderMarkdown(container, source) {
  if (lastRenderedSource.get(container) === source) return;
  lastRenderedSource.set(container, source);
  container.innerHTML = renderMarkdownToHtml(source);
  for (const image of container.querySelectorAll("img")) {
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
  }
  for (const link of container.querySelectorAll("a[href]")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  const enhancements = [...container.querySelectorAll("[data-mermaid]")].map(renderDiagram);
  if (container.querySelector("[data-math]")) enhancements.push(renderMath(container));
  return Promise.allSettled(enhancements);
}

async function renderMath(container) {
  const pending = [...container.querySelectorAll("[data-math]")];
  if (!stylesheetInstalled) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "https://cdn.jsdelivr.net/npm/katex@0.16.38/dist/katex.min.css";
    document.head.append(stylesheet);
    stylesheetInstalled = true;
  }
  try {
    const { default: katex } = await (katexModule ||= import("https://cdn.jsdelivr.net/npm/katex@0.16.38/dist/katex.mjs"));
    for (const code of pending) {
      if (!container.contains(code)) continue;
      const math = document.createElement(code.dataset.math === "display" ? "div" : "span");
      math.className = "note-math";
      katex.render(code.textContent, math, {
        displayMode: code.dataset.math === "display",
        throwOnError: false,
        trust: false,
        maxExpand: 200,
        maxSize: 25
      });
      code.replaceWith(math);
    }
  } catch {
    katexModule = undefined;
  }
}

async function diagramSource(source) {
  if (source.length > 10000 || /%%\s*\{|^\s*---/.test(source)) {
    throw new Error("Use a diagram without configuration directives.");
  }
  const mermaid = await (mermaidModule ||= import("https://cdn.jsdelivr.net/npm/mermaid@11.14.0/dist/mermaid.esm.min.mjs")
    .then(({ default: instance }) => {
      instance.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: {
          primaryColor: "#edf1e9",
          primaryTextColor: "#272b26",
          primaryBorderColor: "#8c9a88",
          lineColor: "#607260",
          fontFamily: "Inter, system-ui, sans-serif"
        },
        flowchart: { htmlLabels: false, curve: "linear" }
      });
      return instance;
    }));
  const { svg } = await mermaid.render(`plop-diagram-${++nextDiagramId}`, source);
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

async function renderDiagram(code) {
  const source = code.textContent;
  if (!diagramCache.has(source)) {
    if (diagramCache.size >= 20) diagramCache.delete(diagramCache.keys().next().value);
    diagramCache.set(source, diagramSource(source));
  }
  try {
    const src = await diagramCache.get(source);
    if (!code.isConnected) return;
    const image = document.createElement("img");
    image.alt = "Mermaid diagram";
    image.className = "note-diagram";
    image.src = src;
    code.parentElement.replaceWith(image);
  } catch {
    if (code.isConnected) code.parentElement.title = "Could not render this Mermaid diagram";
  }
}

const inlineMarkers = { bold: "**", italic: "*", underline: "++", strike: "~~", highlight: "==" };
const lineMarkers = { quote: "> ", bullets: "- " };

function codeDelimiter(text, minimum) {
  const runs = text.match(/`+/g) || [];
  return "`".repeat(Math.max(minimum, ...runs.map((run) => run.length + 1)));
}

export function formatMarkdown(source, start, end, style) {
  const selected = source.slice(start, end);
  if (style === "image") {
    const prefix = `![${selected.replace(/[\[\]\n]/g, " ")}](`;
    const url = "https://";
    return { start, end, text: prefix + url + ")",
      selectionStart: start + prefix.length, selectionEnd: start + prefix.length + url.length };
  }
  if (style in lineMarkers || style === "fence") {
    const lineStart = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
    const nextBreak = source.indexOf("\n", end > start && source[end - 1] === "\n" ? end - 1 : end);
    const lineEnd = nextBreak < 0 ? source.length : nextBreak;
    const lines = source.slice(lineStart, lineEnd);
    if (style === "fence") {
      const fence = codeDelimiter(lines, 3);
      const prefix = fence + "\n";
      return { start: lineStart, end: lineEnd, text: prefix + lines + "\n" + fence,
        selectionStart: start + prefix.length, selectionEnd: Math.min(end, lineEnd) + prefix.length };
    }
    const marker = lineMarkers[style];
    const parts = lines.split("\n");
    const remove = parts.every((line) => line.startsWith(marker));
    const text = parts.map((line) => remove ? line.slice(marker.length) : marker + line).join("\n");
    return { start: lineStart, end: lineEnd, text,
      selectionStart: lineStart + (selected ? 0 : text.length), selectionEnd: lineStart + text.length };
  }

  if (style !== "code" && selected.trim()) {
    start += selected.length - selected.trimStart().length;
    end -= selected.length - selected.trimEnd().length;
  }
  const content = source.slice(start, end);
  const marker = style === "code" ? codeDelimiter(content, 1) : inlineMarkers[style];
  const codeNeedsPadding = content.startsWith("`") || content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && content.trim());
  const padding = style === "code" && codeNeedsPadding ? " " : "";
  if (style !== "code" && source.slice(start - marker.length, start) === marker &&
      source.slice(end, end + marker.length) === marker) {
    return { start: start - marker.length, end: end + marker.length, text: content,
      selectionStart: start - marker.length, selectionEnd: end - marker.length };
  }
  const opening = marker + padding;
  return { start, end, text: opening + content + padding + marker,
    selectionStart: start + opening.length, selectionEnd: end + opening.length };
}

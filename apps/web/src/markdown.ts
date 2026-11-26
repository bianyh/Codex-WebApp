function mapOutsideCodeFences(markdown: string, transform: (text: string) => string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let start = 0;
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (!match) continue;
    const [, marker = "", rest = ""] = match;
    if (fence) {
      if (marker[0] !== fence[0] || marker.length < fence.length || rest) continue;
      output.push(lines.slice(start, index + 1).join("\n"));
      start = index + 1;
      fence = undefined;
    } else if (marker[0] === "~" || !rest.includes("`")) {
      if (index > start) output.push(transform(lines.slice(start, index).join("\n")));
      start = index;
      fence = marker;
    }
  }
  if (start < lines.length) {
    const tail = lines.slice(start).join("\n");
    output.push(fence ? tail : transform(tail));
  }
  return output.join("\n");
}

const flowchartHeader = /^( {0,3})(?:([^\s>~`].*?[:：])[ \t]*)?((?:flowchart|graph)[ \t]+(?:TB|TD|BT|RL|LR);?[ \t]*)\r?$/;
const flowchartNodeOrEdge = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:[[({]|@\{|[ \t]*(?:&[ \t]*[\p{L}\p{N}_]|<?(?:--|==|-\.)|[xo]--|~~~))/u;
const flowchartStatement = /^(?:%%|subgraph\s+\S|direction\s+(?:TB|TD|BT|RL|LR)\b|end;?$|(?:style|classDef|class|linkStyle|click)\s+\S+\s+\S|acc(?:Title|Descr)\s*:)/;

function fenceFlowcharts(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const header = flowchartHeader.exec(line);
    if (!header) {
      output.push(line);
      continue;
    }

    let hasNode = false;
    let end = index + 1;
    for (let next = end; next < lines.length; next += 1) {
      const statement = lines[next]?.trim();
      if (!statement) continue;
      if (flowchartNodeOrEdge.test(statement)) hasNode = true;
      else if (!flowchartStatement.test(statement)) break;
      end = next + 1;
    }
    if (!hasNode) {
      output.push(line);
      continue;
    }

    const [, indent = "", intro, declaration = ""] = header;
    if (intro) output.push(indent + intro);
    output.push("", "```mermaid", intro ? declaration : line, ...lines.slice(index + 1, end), "```", "");
    index = end - 1;
  }
  return output.join("\n");
}

export function normalizeBareMermaid(markdown: string): string {
  return mapOutsideCodeFences(markdown, fenceFlowcharts);
}

function looksLikeLatex(value: string): boolean {
  return /\\(?:mathcal|operatorname|mathrm|mathbf|mathbb|mathsf|mathit|frac|dfrac|tfrac|sqrt|sum|prod|int|lim|begin|end|left|right|text|underbrace|overbrace|delta|Delta|theta|lambda|mu|sigma|phi|psi|omega|in|notin|mid|cdot|times|leq|geq|neq|approx|star|partial|nabla)\b/.test(value) ||
    (/\\[A-Za-z]+/.test(value) && /[_^{}]/.test(value));
}

function normalizeBracketedMath(value: string): string {
  const lines = value.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opening = /^\s*\[\s*(.*)$/.exec(line);
    if (!opening || opening[1]?.includes("](")) {
      output.push(line);
      continue;
    }
    const body: string[] = [];
    let closingIndex = index;
    let candidate = opening[1] ?? "";
    for (;;) {
      const closing = /^(.*?)\s*\]\s*$/.exec(candidate);
      if (closing) {
        body.push(closing[1] ?? "");
        break;
      }
      body.push(candidate);
      closingIndex += 1;
      if (closingIndex >= lines.length) break;
      candidate = lines[closingIndex] ?? "";
    }
    const formula = body.join("\n").trim();
    if (closingIndex < lines.length && looksLikeLatex(formula)) {
      output.push("$$", formula, "$$");
      index = closingIndex;
    } else {
      output.push(line);
    }
  }
  return output.join("\n");
}

function normalizeMathText(value: string): string {
  let normalized = value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`);

  // Some model/provider combinations remove the slash from \[ and \] while
  // leaving the TeX commands intact. Only reinterpret a complete bracketed
  // line/block when its body is unmistakably LaTeX, so Markdown links and
  // task-list syntax remain untouched.
  return normalizeBracketedMath(normalized);
}

function normalizeTextSegment(value: string): string {
  let result = "";
  let cursor = 0;
  const inlineCode = /(`+)([\s\S]*?)\1/g;
  for (const match of value.matchAll(inlineCode)) {
    const index = match.index ?? 0;
    result += normalizeMathText(value.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + normalizeMathText(value.slice(cursor));
}

export function normalizeMarkdownMath(markdown: string): string {
  return mapOutsideCodeFences(markdown, normalizeTextSegment);
}

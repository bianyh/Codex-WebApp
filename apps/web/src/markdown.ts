const fencedCode = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;

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
  let result = "";
  let cursor = 0;
  for (const match of markdown.matchAll(fencedCode)) {
    const index = match.index ?? 0;
    result += normalizeTextSegment(markdown.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + normalizeTextSegment(markdown.slice(cursor));
}

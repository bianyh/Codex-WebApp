import { describe, expect, it } from "vitest";
import { normalizeBareMermaid, normalizeMarkdownMath } from "./markdown";

describe("Markdown flowchart compatibility", () => {
  const diagram = 'flowchart LR\n    A["当前目标"] --> B["执行下一步"]\n    B --> A';

  it("wraps a bare chart while preserving original indentation and surrounding prose", () => {
    expect(normalizeBareMermaid(`流程如下：\n${diagram}\nAfter (the diagram).`))
      .toBe(`流程如下：\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nAfter (the diagram).`);
  });

  it("preserves fenced examples, including longer fences and unfinished code", () => {
    const source = ["````text", "```", diagram, "````", "~~~text", diagram].join("\n");
    expect(normalizeBareMermaid(source)).toBe(source);
  });

  it("requires diagram statements and leaves indented snippets alone", () => {
    const source = "graph TD\nordinary text\n\n    flowchart LR\n      A --> B";
    expect(normalizeBareMermaid(source)).toBe(source);
  });
});

describe("Markdown math compatibility", () => {
  it("normalizes standard LaTeX display and inline delimiters", () => {
    expect(normalizeMarkdownMath(String.raw`Before \(x^2\) and \[\frac{1}{2}\]`))
      .toContain("Before $x^2$ and \n$$\n\\frac{1}{2}\n$$");
  });

  it("recognizes bracketed model output that is clearly LaTeX", () => {
    const source = String.raw`[ \mathcal E_j
{ e_i \mid i\in[t-H,t], \operatorname{Rel}(e_i,e^\star)>\delta_r, v_i=1 },
]`;
    expect(normalizeMarkdownMath(source)).toBe(String.raw`$$
\mathcal E_j
{ e_i \mid i\in[t-H,t], \operatorname{Rel}(e_i,e^\star)>\delta_r, v_i=1 },
$$`);
  });

  it("does not reinterpret links, task lists, inline code, or fenced code", () => {
    const source = [
      "[file](README.md)",
      "- [x] done",
      "`[ \\frac{1}{2} ]`",
      "```tex",
      "[ \\frac{1}{2} ]",
      "```",
    ].join("\n");
    expect(normalizeMarkdownMath(source)).toBe(source);
  });
});

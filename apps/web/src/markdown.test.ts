import { describe, expect, it } from "vitest";
import { normalizeMarkdownMath } from "./markdown";

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

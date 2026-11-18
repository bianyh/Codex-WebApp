function normalizeLocalPath(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export function resolveLocalFileHref(href: string | undefined, cwd?: string): { path: string; pdfPage?: number } | null {
  if (!href) return null;
  let source = href.trim();
  if (!source || source.startsWith("#") || source.startsWith("//")) return null;
  if (/^(?:file:\/\/\/|sandbox:\/)/i.test(source)) source = source.replace(/^(?:file:\/\/|sandbox:)/i, "");
  else if (/^(?:https?|mailto|tel|data|blob|javascript|file|sandbox):/i.test(source) || (/^[a-z][a-z\d+.-]*:/i.test(source) && !/:\d+(?::\d+)?$/.test(source))) return null;
  const hash = source.indexOf("#");
  const beforeHash = decodePath(hash < 0 ? source : source.slice(0, hash));
  let pdfPage: number | undefined;
  let value: string;
  if (/\.pdf$/i.test(beforeHash) && hash >= 0) {
    const page = new URLSearchParams(source.slice(hash + 1)).get("page");
    const number = page && /^\d+$/.test(page) ? Number(page) : 0;
    if (Number.isSafeInteger(number) && number > 0) pdfPage = number;
    value = beforeHash;
  } else {
    value = decodePath(source.replace(/#L\d+(?:C\d+)?$/i, "")).replace(/:\d+(?::\d+)?$/, "");
  }
  if (!value || value.includes("\0")) return null;
  const filePath = value.startsWith("/") ? value : cwd ? `${cwd}/${value}` : null;
  return filePath ? { path: normalizeLocalPath(filePath), ...(pdfPage ? { pdfPage } : {}) } : null;
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

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

export function resolveLocalFileHref(href: string | undefined, cwd?: string): string | null {
  if (!href) return null;
  let value: string;
  try {
    value = decodeURIComponent(href.trim());
  } catch {
    value = href.trim();
  }
  if (!value || value.startsWith("#") || /^(?:https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(value)) return null;
  value = value.replace(/^(?:file:\/\/|sandbox:)/i, "");
  value = value.replace(/#L\d+(?:C\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
  if (!value) return null;
  if (value.startsWith("/")) return normalizeLocalPath(value);
  if (!cwd) return null;
  return normalizeLocalPath(`${cwd.replace(/\/$/, "")}/${value}`);
}

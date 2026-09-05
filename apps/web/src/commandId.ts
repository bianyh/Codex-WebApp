type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

function fallbackRandomValues(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}

/**
 * Generate a command request ID on both HTTPS/localhost and plain HTTP LAN
 * origins. `crypto.randomUUID()` is secure-context-only in several mobile
 * browsers, while `getRandomValues()` may still be available over HTTP.
 */
export function createCommandId(source: RandomSource | undefined = typeof globalThis === "undefined" ? undefined : globalThis.crypto): string {
  try {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
  } catch {
    // Fall through when randomUUID is unavailable or rejects this origin.
  }
  const bytes = new Uint8Array(16);
  try {
    if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes);
    else fallbackRandomValues(bytes);
  } catch {
    fallbackRandomValues(bytes);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeReviewId(prUrl: string): string {
  if (typeof window === "undefined") {
    return Buffer.from(prUrl, "utf-8").toString("base64url");
  }
  const b64 = btoa(unescape(encodeURIComponent(prUrl)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeReviewId(id: string): string {
  const padded = id + "=".repeat((4 - (id.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof window === "undefined") {
    return Buffer.from(b64, "base64").toString("utf-8");
  }
  return decodeURIComponent(escape(atob(b64)));
}

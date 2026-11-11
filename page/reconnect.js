// Only return to this plugin's Magpie bootstrap. The token stays in the
// fragment, never in a request to the local service or in a Referer header.
globalThis.artexReconnectURL = (value, current) => {
  if (!value) return null;
  try {
    const target = new URL(value), source = new URL(current);
    if (!/(?:^|\/)_magpie\/plugin\/[a-f0-9]{32}\/(?:agents|bootstrap)\.html$/.test(target.pathname)) return null;
    if (target.username || target.password || target.hash) return null;
    const native = target.protocol === "wails:" && target.hostname === "localhost";
    const local = target.protocol === "http:" && ["wails.localhost", "localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
    const same = ["http:", "https:"].includes(target.protocol) && target.origin === source.origin;
    return native || local || same ? target.href : null;
  } catch { return null; }
};

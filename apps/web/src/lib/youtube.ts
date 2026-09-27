// Client-side YouTube URL check (§10 C1), mirroring the server's accepted forms
// (§6.4). The server stays authoritative. Implemented by the web-lib workstream.
//
// Accepted (after trimming; the scheme is optional, http or https, case-insensitive):
//   youtube.com | www.youtube.com | m.youtube.com   /watch?v=<ID>
//                                                   /shorts/<ID>   (optional "/")
//   music.youtube.com                               /watch?v=<ID>
//   youtu.be                                        /<ID>
// - <ID> must match ^[A-Za-z0-9_-]{11}$ exactly.
// - Hosts are case-insensitive; paths are case-sensitive.
// - The query is otherwise ignored (list, t, si, feature, …). For /watch the first
//   `v` parameter wins, percent-decoded. A #fragment is always ignored.
// - Everything else is rejected: other schemes, a scheme-relative "//" start, any
//   userinfo (user@) or port, other hosts (youtube-nocookie.com, lookalikes, a
//   trailing-dot host), /playlist, /embed/, /live/, channels and @handles, a
//   trailing slash on youtu.be or /watch, and IDs of any other length.
// We parse by hand rather than with `new URL`, whose leniency (backslashes as
// slashes, "https:/host", stripped tabs) would accept inputs the server rejects.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SHORTS_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const WATCH_HOSTS = new Set([...SHORTS_HOSTS, "music.youtube.com"]);
const SHORTS_PATH = /^\/shorts\/([^/]+)\/?$/;
const SHORT_LINK_PATH = /^\/([^/]+)$/;

/** The 11-char video ID for an accepted YouTube URL, else null. */
export function extractVideoId(input: string): string | null {
  let rest = input.trim();

  const scheme = SCHEME.exec(rest)?.[0];
  if (scheme !== undefined) {
    const lower = scheme.toLowerCase();
    if (lower !== "http://" && lower !== "https://") return null;
    rest = rest.slice(scheme.length);
  }

  // Split "host/path?query#fragment", dropping the fragment.
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const pathAndQuery = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  const queryAt = pathAndQuery.indexOf("?");
  const path = queryAt < 0 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const query = queryAt < 0 ? "" : pathAndQuery.slice(queryAt + 1);

  // A bare host only: no userinfo, no port, no empty host (also rejects "//host"
  // and scheme-like prefixes such as "javascript:" or "mailto:").
  if (!/^[A-Za-z0-9.-]+$/.test(authority)) return null;
  const host = authority.toLowerCase();

  let id: string | null = null;
  if (host === "youtu.be") {
    id = SHORT_LINK_PATH.exec(path)?.[1] ?? null;
  } else if (WATCH_HOSTS.has(host) && path === "/watch") {
    id = new URLSearchParams(query).get("v");
  } else if (SHORTS_HOSTS.has(host)) {
    id = SHORTS_PATH.exec(path)?.[1] ?? null;
  }

  return id !== null && VIDEO_ID.test(id) ? id : null;
}

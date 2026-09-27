import { describe, expect, it } from "vitest";
import { extractVideoId } from "./youtube";

const ID = "dQw4w9WgXcQ";
const ID2 = "a-_B9zZ0x1Y"; // uses "-" and "_"

const ACCEPTED: [string, string][] = [
  // youtube.com /watch, with and without scheme and www/m
  [`https://www.youtube.com/watch?v=${ID}`, ID],
  [`http://www.youtube.com/watch?v=${ID}`, ID],
  [`https://youtube.com/watch?v=${ID}`, ID],
  [`https://m.youtube.com/watch?v=${ID}`, ID],
  [`www.youtube.com/watch?v=${ID}`, ID],
  [`youtube.com/watch?v=${ID}`, ID],
  [`m.youtube.com/watch?v=${ID}`, ID],
  [`https://www.youtube.com/watch?v=${ID2}`, ID2],
  // case-insensitive scheme and host
  [`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, ID],
  [`Https://YouTube.com/watch?v=${ID}`, ID],
  // surrounding whitespace is trimmed
  [`   https://www.youtube.com/watch?v=${ID}  `, ID],
  [`\n\thttps://youtu.be/${ID}\n`, ID],
  // extra params are ignored, in any order
  [`https://www.youtube.com/watch?v=${ID}&list=PL1234567890`, ID],
  [`https://www.youtube.com/watch?v=${ID}&t=42s`, ID],
  [`https://www.youtube.com/watch?v=${ID}&si=abcDEF123`, ID],
  [`https://www.youtube.com/watch?feature=share&v=${ID}`, ID],
  [`https://www.youtube.com/watch?list=PL123&index=3&v=${ID}&t=1`, ID],
  [`https://www.youtube.com/watch?app=desktop&v=${ID}`, ID],
  // the first v wins
  [`https://www.youtube.com/watch?v=${ID}&v=${ID2}`, ID],
  // percent-encoded v is decoded
  [`https://www.youtube.com/watch?v=%64Qw4w9WgXcQ`, ID],
  // fragments are ignored
  [`https://www.youtube.com/watch?v=${ID}#t=30`, ID],
  [`https://youtu.be/${ID}#frag`, ID],
  // Shorts on youtube.com / www / m, optional trailing slash and query
  [`https://www.youtube.com/shorts/${ID}`, ID],
  [`https://youtube.com/shorts/${ID}`, ID],
  [`https://m.youtube.com/shorts/${ID}`, ID],
  [`youtube.com/shorts/${ID}`, ID],
  [`https://www.youtube.com/shorts/${ID}/`, ID],
  [`https://www.youtube.com/shorts/${ID}?feature=share`, ID],
  [`https://www.youtube.com/shorts/${ID}/?si=xyz`, ID],
  // music.youtube.com /watch
  [`https://music.youtube.com/watch?v=${ID}`, ID],
  [`music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`, ID],
  // youtu.be, ignoring the query
  [`https://youtu.be/${ID}`, ID],
  [`http://youtu.be/${ID}`, ID],
  [`youtu.be/${ID}`, ID],
  [`https://youtu.be/${ID}?si=AbC123&t=30`, ID],
  [`https://youtu.be/${ID}?list=PL123`, ID],
  [`HTTPS://YOUTU.BE/${ID}`, ID],
];

const REJECTED: [string, string][] = [
  // empty and junk
  ["", "empty"],
  ["   ", "whitespace"],
  ["hello world", "not a URL"],
  [ID, "a bare ID"],
  ["https://", "scheme only"],
  // playlists and other YouTube pages
  ["https://www.youtube.com/playlist?list=PL1234567890", "playlist"],
  [`https://www.youtube.com/playlist?list=PL123&v=${ID}`, "playlist with v"],
  [`https://www.youtube.com/embed/${ID}`, "embed"],
  [`https://www.youtube.com/live/${ID}`, "live"],
  [`https://www.youtube.com/v/${ID}`, "old /v/ form"],
  [`https://www.youtube.com/e/${ID}`, "old /e/ form"],
  ["https://www.youtube.com/@SomeChannel", "@handle"],
  ["https://www.youtube.com/channel/UC1234567890abcdefghij", "channel"],
  ["https://www.youtube.com/c/SomeName", "custom channel"],
  ["https://www.youtube.com/user/SomeName", "legacy user"],
  ["https://www.youtube.com/", "home page"],
  ["https://www.youtube.com", "bare host"],
  ["youtube.com", "bare host, no scheme"],
  ["https://www.youtube.com/results?search_query=song", "search"],
  [`https://www.youtube.com/attribution_link?v=${ID}`, "attribution link"],
  // /watch variants that aren't exactly /watch
  [`https://www.youtube.com/watch/?v=${ID}`, "watch with trailing slash"],
  [`https://www.youtube.com/Watch?v=${ID}`, "path is case-sensitive"],
  [`https://www.youtube.com/watch/${ID}`, "ID in the watch path"],
  [`https://www.youtube.com/watch?vid=${ID}`, "wrong parameter name"],
  [`https://www.youtube.com/watch#v=${ID}`, "v in the fragment"],
  [`https://www.youtube.com/?v=${ID}`, "v on the root path"],
  [`https://www.youtube.com?v=${ID}`, "v with no path"],
  ["https://www.youtube.com/watch", "watch without v"],
  ["https://www.youtube.com/watch?v=", "empty v"],
  // shorts variants
  ["https://www.youtube.com/shorts/", "shorts without ID"],
  [`https://www.youtube.com/shorts/${ID}/extra`, "shorts with extra segment"],
  [`https://www.youtube.com/shorts//${ID}`, "shorts with double slash"],
  [`https://www.youtube.com/SHORTS/${ID}`, "shorts path is case-sensitive"],
  [`https://music.youtube.com/shorts/${ID}`, "shorts on music"],
  // music.youtube.com only supports /watch
  ["https://music.youtube.com/playlist?list=OLAK5uy_abc", "music playlist"],
  [`https://music.youtube.com/browse/${ID}`, "music browse"],
  // youtu.be variants
  [`https://youtu.be/${ID}/`, "youtu.be trailing slash"],
  [`https://youtu.be/${ID}/extra`, "youtu.be extra segment"],
  ["https://youtu.be/", "youtu.be without ID"],
  [`https://youtu.be/watch?v=${ID}`, "youtu.be watch form"],
  [`https://youtu.be?v=${ID}`, "youtu.be query only"],
  // wrong ID lengths and characters
  ["https://www.youtube.com/watch?v=dQw4w9WgXc", "10-char ID"],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQQ", "12-char ID"],
  ["https://youtu.be/dQw4w9WgXc", "10-char youtu.be ID"],
  ["https://youtu.be/dQw4w9WgXcQQ", "12-char youtu.be ID"],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQQ", "12-char shorts ID"],
  ["https://www.youtube.com/watch?v=dQw4w9WgX.Q", "dot in ID"],
  ["https://www.youtube.com/watch?v=dQw4w9WgX+Q", "plus (a space) in ID"],
  ["https://www.youtube.com/watch?v=dQw4w9WgX%20", "encoded space in ID"],
  ["https://youtu.be/dQw4w9WgX%51", "percent-encoding in a path ID"],
  [`https://www.youtube.com/watch?v=${ID} extra`, "text after the ID"],
  // other hosts
  [`https://www.youtube-nocookie.com/embed/${ID}`, "youtube-nocookie embed"],
  [`https://youtube-nocookie.com/watch?v=${ID}`, "youtube-nocookie watch"],
  [`https://gaming.youtube.com/watch?v=${ID}`, "gaming subdomain"],
  [`https://studio.youtube.com/watch?v=${ID}`, "studio subdomain"],
  [`https://www.youtube.co.uk/watch?v=${ID}`, "country domain"],
  [`https://youtube.com.evil.example/watch?v=${ID}`, "lookalike suffix"],
  [`https://evilyoutube.com/watch?v=${ID}`, "lookalike prefix"],
  [`https://www.youtube.com./watch?v=${ID}`, "trailing-dot host"],
  [`https://www.youtu.be/${ID}`, "www.youtu.be"],
  [
    `https://evil.example/?u=youtube.com/watch?v=${ID}`,
    "YouTube URL in a query",
  ],
  [`https://evil.example/youtube.com/watch?v=${ID}`, "YouTube URL in a path"],
  [`https://vimeo.com/${ID}`, "another site"],
  // userinfo, ports and other authority tricks
  [`https://user@youtube.com/watch?v=${ID}`, "userinfo"],
  [
    `https://youtube.com@evil.example/watch?v=${ID}`,
    "host smuggled as userinfo",
  ],
  [`https://evil.example@youtube.com/watch?v=${ID}`, "evil userinfo"],
  [`https://youtube.com:443/watch?v=${ID}`, "explicit port"],
  [`youtube.com:8080/watch?v=${ID}`, "port without scheme"],
  [`https://[::1]/watch?v=${ID}`, "IPv6 literal"],
  [`https://you tube.com/watch?v=${ID}`, "space in host"],
  // other schemes and malformed scheme separators
  [`ftp://youtube.com/watch?v=${ID}`, "ftp"],
  [`file://youtube.com/watch?v=${ID}`, "file"],
  [`ws://youtube.com/watch?v=${ID}`, "ws"],
  [`javascript:alert("youtube.com/watch?v=${ID}")`, "javascript"],
  [`javascript://youtube.com/watch?v=${ID}`, "javascript with slashes"],
  [`data:text/html,youtube.com/watch?v=${ID}`, "data"],
  [`mailto:someone@youtube.com?v=${ID}`, "mailto"],
  [`//youtube.com/watch?v=${ID}`, "scheme-relative"],
  [`https:/youtube.com/watch?v=${ID}`, "one slash"],
  [`https:///youtube.com/watch?v=${ID}`, "three slashes"],
  [`https:youtube.com/watch?v=${ID}`, "no slashes"],
  [`https://youtube.com\\watch?v=${ID}`, "backslash path"],
  [`youtube://watch?v=${ID}`, "app scheme"],
];

describe("extractVideoId", () => {
  it.each(ACCEPTED)("accepts %s", (input, id) => {
    expect(extractVideoId(input)).toBe(id);
  });

  it.each(REJECTED)("rejects %j (%s)", (input) => {
    expect(extractVideoId(input)).toBeNull();
  });
});

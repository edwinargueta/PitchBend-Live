// Small inline SVG icons; decorative only (labels live on the controls).
export type IconName =
  "play" | "pause" | "upload" | "download" | "reset" | "back";

const PATHS: Record<IconName, string> = {
  play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  upload: "M12 3l-5 5h3v6h4V8h3l-5-5zM5 17h14v3H5z",
  download: "M12 21l5-5h-3v-6h-4v6H7l5 5zM5 4h14v3H5z",
  reset: "M12 5a7 7 0 1 1-6.93 8h2.02A5 5 0 1 0 12 7v3L7.5 6 12 2v3z",
  back: "M15.5 5.5 9 12l6.5 6.5-1.5 1.5-8-8 8-8z",
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}

import "./components.css";

interface SkeletonProps {
  /** Announced to assistive tech in place of the shimmer. */
  label: string;
  width?: string;
  height?: string;
  className?: string;
}

/** A shimmering placeholder (e.g. the key badge while the key is analyzed). */
export function Skeleton({ label, width, height, className }: SkeletonProps) {
  return (
    <span
      className={["skeleton-wrap", className ?? ""].filter(Boolean).join(" ")}
    >
      <span className="skeleton" aria-hidden="true" style={{ width, height }} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

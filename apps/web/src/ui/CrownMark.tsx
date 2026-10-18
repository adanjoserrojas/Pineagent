/** Pineapple silhouette: sharp leaves and a faceted body, not a mascot overlay. */
export function CrownMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="28" height="32" viewBox="0 0 32 36" fill="none" aria-hidden="true">
      <path className="crown-leaves" d="m16 15-10-9 8 2 2-8 3 8 8-3-8 10Z" fill="currentColor" />
      <path d="m16 15 10 6-3 10-7 5-7-5-3-10Z" fill="currentColor" />
      <path d="m8 21 14 10M10 17l15 10M24 21 10 31M22 17 7 27" stroke="var(--ground)" strokeWidth="1.2" />
    </svg>
  );
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--logo-bg)" />
      <rect x="5" y="7" width="13" height="4" rx="1.5" fill="#76b900" />
      <rect x="11" y="14" width="16" height="4" rx="1.5" fill="#6098ff" />
      <rect x="7" y="21" width="9" height="4" rx="1.5" fill="#f59e0b" />
      <rect x="18" y="21" width="7" height="4" rx="1.5" fill="#76b900" />
    </svg>
  );
}

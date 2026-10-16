export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="docs-brand">
      <img src="/brand/cluevia-mark.webp" width="30" height="30" alt="" />
      <span>Cluevia<span className="brand-period">.</span></span>
      {!compact && <span className="brand-divider" aria-hidden="true" />}
      {!compact && <span className="brand-label">ALGORITHMS</span>}
    </span>
  );
}

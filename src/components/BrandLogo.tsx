const logoUrl = '/cluevia-logo.png';

/** Separate viewports let the original symbol and wordmark have their own spacing. */
export default function BrandLogo() {
  return <span className="brand-logo" aria-hidden="true">
    <BrandMark size={24.32} />
    <svg className="brand-wordmark" width="66.88" height="24.32" viewBox="685 95 1390 505" fill="none" aria-hidden="true" focusable="false"><image href={logoUrl} width="2172" height="724" /></svg>
  </span>;
}

/** The same original artwork, framed around its symbol for compact placements. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="145 80 540 540" fill="none" aria-hidden="true" focusable="false"><image href={logoUrl} width="2172" height="724" /></svg>;
}

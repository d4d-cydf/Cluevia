import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import './gap-review-overlay.css';

export interface GapReviewOverlayProps {
  children: ReactNode;
  title?: string;
  description?: string;
  hidden?: boolean;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
}

/** A canvas-contained review surface. Hidden children keep their editing draft. */
export default function GapReviewOverlay({ children, title = 'Evidence check', description, hidden = false, onClose, onOpenChange }: GapReviewOverlayProps) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose); close.current = onClose;
  const changed = useRef(onOpenChange); changed.current = onOpenChange;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (hidden) return;
    const previous = document.activeElement;
    opener.current = previous instanceof HTMLElement && !panel.current?.contains(previous) ? previous : null;
    const frame = requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    const escape = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); close.current();
    };
    window.addEventListener('keydown', escape, true);
    changed.current?.(true);
    return () => {
      cancelAnimationFrame(frame); window.removeEventListener('keydown', escape, true);
      changed.current?.(false);
      const current = document.activeElement;
      // Do not pull focus back after the user has selected another graph item.
      if ((!current || current === document.body || panel.current?.contains(current)) && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [hidden]);

  return <section ref={panel} className="gap-review-overlay" hidden={hidden} role="dialog" aria-modal="false" aria-label="공백 검토" aria-describedby={description ? descriptionId : undefined} data-overview-detail data-gap-review>
    <header className="gro-heading">
      <div><span>CHECKS</span><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
      <button ref={closeButton} type="button" aria-label="공백 검토 닫기" onClick={onClose}><span aria-hidden="true">×</span></button>
    </header>
    <div className="gro-content">{children}</div>
  </section>;
}

import type { SVGProps } from 'react';

const paths = {
  plus: 'M12 5v14M5 12h14',
  attach: 'M20 11.5 12.6 18.9a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1',
  send: 'M12 19V5.5M6.5 11 12 5.5l5.5 5.5',
  replay: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  close: 'M7 7l10 10M17 7 7 17',
  check: 'M5 12.5l4.5 4.5L19 7.5',
};

export function Icon({ name, size = 16, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}

import { GraphCanvas, type GraphLayout, type GraphViewProps } from './BoardView';

const LANES_LAYOUT: GraphLayout = {
  lead: [11, 46],
  cert: [33, 16],
  sib2: [33, 28],
  ip: [33, 40],
  asn: [33, 52],
  sib1: [33, 64],
  sib3: [33, 76],
  post: [55, 34],
  kit: [55, 48],
  wallet: [77, 38],
  exch: [77, 52],
};

export default function LanesView(props: GraphViewProps) {
  return <GraphCanvas {...props} layout={LANES_LAYOUT} lanes />;
}

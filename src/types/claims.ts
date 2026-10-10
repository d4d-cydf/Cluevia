/** A source assertion. It is never an analyst verification or a probability of truth. */
export interface RelationClaim {
  stance: 'asserted' | 'denied' | 'retracted' | 'uncertain';
  attributedTo: string | null;
  validFrom: string | null;
  validTo: string | null;
  publishedAt: string | null;
  derivedFrom: string | null;
}
export interface ClaimReview {
  status: 'unreviewed' | 'supported' | 'disputed' | 'needs-review';
  note: string;
  updatedAt: string;
}

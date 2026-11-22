const sourceLinkCount = 256;

/** The existing reader boundaries and what each reader reports above them. */
export const readerLimits = {
  sourceLinkInventory: { maximum: sourceLinkCount, reason: 'node-limit' },
  causeCommits: { maximum: 4096, reason: 'node-limit' },
  traceRows: { maximum: 128, reason: 'node-limit' },
  binderLocators: { maximum: sourceLinkCount, reason: 'node-limit' },
  binderWork: { maximum: 1_000_000, reason: 'truncated' },
  causeTextWork: { maximum: 1_000_000, reason: 'truncated' },
  storedAddress: { maximum: 65_536, reason: 'unread' },
} as const;

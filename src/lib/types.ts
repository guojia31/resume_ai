export type ResumeItem = {
  id: string;
  candidateName: string;
  fileName?: string;
  rawText: string;
  normalizedText: string;
  hash: string;
  createdAtUtc: string;
};

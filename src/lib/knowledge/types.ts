import type { SourceCitation } from "@/types";

export interface PolicyPassage extends SourceCitation {
  content: string;
  score?: number;
}

export interface PolicyRetriever {
  retrieve(query: string, options?: { limit?: number; minScore?: number }): Promise<PolicyPassage[]>;
}

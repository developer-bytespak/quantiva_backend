export interface IndexConstituent {
  symbol: string;
  name?: string;
  weight?: number;
}

export interface IndexSourceResult {
  symbols: IndexConstituent[];
  sourceUrl: string;
  fetchedAt: Date;
}

export interface IndexSourceService {
  readonly indexCode: string;
  readonly displayName: string;
  fetchConstituents(): Promise<IndexSourceResult>;
}

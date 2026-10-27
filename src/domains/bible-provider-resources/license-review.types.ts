export interface LicenseReviewIo {
  ask: (question: string) => Promise<string>;
  write: (message: string) => Promise<void> | void;
}

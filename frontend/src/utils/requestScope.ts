/** Guards both view changes and reads that began before a newer mutation. */
export class RequestScope {
  private valid = true;
  private revision = 0;

  constructor(readonly key: string) {}

  advance(): number {
    return ++this.revision;
  }

  capture(): number {
    return this.revision;
  }

  isCurrent(revision?: number): boolean {
    return this.valid && (revision === undefined || revision === this.revision);
  }

  invalidate(): void {
    this.valid = false;
    this.revision++;
  }
}

import type { PendingComment } from '../sync/commentTypes';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

export class PendingCommentStore {
  private pending: PendingComment[] = [];
  private listeners: Set<() => void> = new Set();
  private vscode: VsCodeApi;

  constructor(vscode: VsCodeApi) {
    this.vscode = vscode;
  }

  add(comment: PendingComment): void {
    this.pending.push(comment);
    this.notify();
    this.persist();
  }

  remove(tempId: string): void {
    this.pending = this.pending.filter(c => c.tempId !== tempId);
    this.notify();
    this.persist();
  }

  get(tempId: string): PendingComment | undefined {
    return this.pending.find(c => c.tempId === tempId);
  }

  getAll(): PendingComment[] {
    return [...this.pending];
  }

  getCount(): number {
    return this.pending.length;
  }

  clear(): void {
    this.pending = [];
    this.notify();
    this.persist();
  }

  clearSuccessful(failedIds: string[]): void {
    const failedSet = new Set(failedIds);
    this.pending = this.pending.filter(c => failedSet.has(c.tempId));
    this.notify();
    this.persist();
  }

  hydrate(pending: PendingComment[]): void {
    this.pending = [...pending];
    this.notify();
    // Do NOT persist — this is the load path
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private persist(): void {
    this.vscode.postMessage({ type: 'savePendingQueue', pending: this.getAll() });
  }
}

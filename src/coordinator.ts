import { BatchStore, type DocumentBaseline, type BatchFile } from './batch';
import { hash } from './patch';
import { ForgePilotError } from './log';
import type { Workspace } from './workspace';

export interface EditorChange { path: string; operation: 'modify' | 'create' | 'delete'; content: string }
export interface EditorHost {
  snapshot(path: string, operation: 'modify' | 'create'): Promise<DocumentBaseline>;
  current(path: string): DocumentBaseline | undefined;
  apply(changes: EditorChange[]): Promise<boolean>;
}
interface UndoFile { file: BatchFile; after: string; version: number; diskHash: string; identity: string }
export class EditCoordinator {
  private undoFiles?: { files: UndoFile[]; workspace: Workspace };
  private busy = false;
  constructor(private readonly host: EditorHost) {}
  private checkIdle(): void { if (this.busy) throw new ForgePilotError('An editor operation is already running.'); }
  async apply(store: BatchStore): Promise<void> {
    this.checkIdle(); const accepted = store.accepted(); this.busy = true;
    try {
      const p = store.current!, states = new Map<string, DocumentBaseline>();
      for (const file of p.files) states.set(file.path, await this.host.snapshot(file.path, file.operation));
      await store.validate(states);
      for (const file of p.files) {
        const state = this.host.current(file.path);
        if (file.operation === 'modify' ? !state || state.version !== file.version || hash(state.content) !== file.baseHash : state && (state.version !== 0 || state.content !== ''))
          throw new ForgePilotError('Document changed during final batch validation.');
      }
      store.beginApply();
      let ok = false;
      try { ok = await this.host.apply(accepted.map(({ file, content }) => ({ path: file.path, operation: file.operation, content }))); }
      catch { /* Evaluate resulting state and attempt only guarded restoration below. */ }
      const results = accepted.map(({ file, content }) => ({ file, content, state: this.host.current(file.path) }));
      if (!ok || results.some(r => r.state?.content !== r.content)) {
        const rollback: EditorChange[] = []; const expected = new Map<string, DocumentBaseline>(); let unsafe = false;
        for (const { file, content, state } of results) {
          if (state?.content === file.before && file.operation === 'modify' && state.version === file.version) continue;
          if (!state && file.operation === 'create') continue;
          if (state?.content === content && (file.operation === 'create' || state.version === file.version + 1)) {
            try {
              const disk = await store.workspace.readFile(file.path);
              if (file.operation === 'modify' ? disk.identity !== file.identity || ![file.baseHash, hash(content)].includes(hash(disk.content)) : ![hash(''), hash(content)].includes(hash(disk.content))) { unsafe = true; continue; }
              // Recheck editor state after I/O before scheduling restoration.
              const now = this.host.current(file.path);
              if (now?.version !== state.version || now.content !== content) { unsafe = true; continue; }
              expected.set(file.path, state);
              rollback.push({ path: file.path, operation: file.operation === 'create' ? 'delete' : 'modify', content: file.before });
            } catch { unsafe = true; }
          } else unsafe = true;
        }
        const safe = rollback.filter(change => { const now = this.host.current(change.path), previous = expected.get(change.path)!; const valid = now?.version === previous.version && now.content === previous.content; if (!valid) unsafe = true; return valid; });
        let restored = !safe.length || await this.host.apply(safe) && safe.every(change => change.operation === 'delete' ? !this.host.current(change.path) : this.host.current(change.path)?.content === change.content);
        if (restored) for (const change of safe) if (change.operation === 'delete') {
          try { await store.workspace.creationPath(change.path); } catch { restored = false; }
        }
        store.finishApply(false);
        throw new ForgePilotError(`Batch application failed. ${unsafe || !restored ? 'Some changes could not be safely restored; inspect all target files.' : 'Applied portions were restored to their preceding contents.'}`);
      }
      const files: UndoFile[] = [];
      for (const { file, content, state } of results) {
        const disk = await store.workspace.readFile(file.path);
        if ((file.operation === 'modify' && disk.identity !== file.identity) || ![file.baseHash, hash(content)].includes(hash(disk.content))) throw new ForgePilotError('Batch applied but a concurrent disk change prevents safe undo. Inspect targets.');
        const now = this.host.current(file.path);
        if (now?.version !== state!.version || now.content !== content) throw new ForgePilotError('Batch applied but a subsequent edit prevents guarded undo. Inspect targets.');
        files.push({ file, after: content, version: state!.version, diskHash: hash(disk.content), identity: disk.identity });
      }
      this.undoFiles = { files, workspace: store.workspace }; store.finishApply(true);
    } catch (error) { store.finishApply(false); throw error; }
    finally { this.busy = false; }
  }
  async undo(): Promise<void> {
    this.checkIdle(); const record = this.undoFiles;
    if (!record) throw new ForgePilotError('No accepted batch to undo.');
    this.busy = true;
    try {
      for (const item of record.files) {
        const disk = await record.workspace.readFile(item.file.path), state = this.host.current(item.file.path);
        if (disk.identity !== item.identity || ![item.diskHash, hash(item.after)].includes(hash(disk.content)) || !state || state.version !== item.version || state.content !== item.after)
          throw new ForgePilotError('Batch undo blocked by subsequent document or external file changes.');
      }
      for (const item of record.files) {
        const state = this.host.current(item.file.path);
        if (!state || state.version !== item.version || state.content !== item.after) throw new ForgePilotError('Batch undo became stale.');
      }
      const ok = await this.host.apply(record.files.map(item => ({ path: item.file.path, operation: item.file.operation === 'create' ? 'delete' : 'modify', content: item.file.before })));
      let restored = ok && record.files.every(item => item.file.operation === 'create' ? !this.host.current(item.file.path) : this.host.current(item.file.path)?.content === item.file.before);
      if (restored) for (const item of record.files) if (item.file.operation === 'create') {
        try { await record.workspace.creationPath(item.file.path); } catch { restored = false; }
      }
      if (!restored)
        throw new ForgePilotError('Batch undo failed or was partial. Inspect all targets.');
      this.undoFiles = undefined;
    } finally { this.busy = false; }
  }
}

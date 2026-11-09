/**
 * Undo/redo stack.
 *
 * Every document mutation is a Command. Selection changes are not commands, but the history
 * records the selection before and after each command, and restores it on undo/redo.
 */

export interface Command {
  readonly label: string;
  apply(): void;
  revert(): void;
}

export interface HistoryHooks<S> {
  getSelection(): S;
  setSelection(s: S): void;
  /** Called after any execute/undo/redo. */
  onChange(): void;
}

interface Entry<S> {
  cmd: Command;
  selBefore: S;
  selAfter: S;
}

export class History<S> {
  private readonly undoStack: Entry<S>[] = [];
  private readonly redoStack: Entry<S>[] = [];
  /** Undo depth at the last save. -1 means the saved state is unreachable. */
  private savedDepth = 0;

  constructor(
    private readonly hooks: HistoryHooks<S>,
    private readonly limit = 500,
  ) {}

  execute(cmd: Command): void {
    const selBefore = this.hooks.getSelection();
    cmd.apply();
    const selAfter = this.hooks.getSelection();
    this.undoStack.push({ cmd, selBefore, selAfter });
    if (this.savedDepth > this.undoStack.length - 1) this.savedDepth = -1; // saved state was in the redo branch
    this.redoStack.length = 0;
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
      this.savedDepth = this.savedDepth > 0 ? this.savedDepth - 1 : -1;
    }
    this.hooks.onChange();
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    e.cmd.revert();
    this.redoStack.push(e);
    this.hooks.setSelection(e.selBefore);
    this.hooks.onChange();
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    e.cmd.apply();
    this.undoStack.push(e);
    this.hooks.setSelection(e.selAfter);
    this.hooks.onChange();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.savedDepth = 0;
    this.hooks.onChange();
  }

  markSaved(): void {
    this.savedDepth = this.undoStack.length;
    this.hooks.onChange();
  }

  get isDirty(): boolean {
    return this.savedDepth !== this.undoStack.length;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.cmd.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.cmd.label ?? null;
  }
}

/** A command made from two closures. */
export class FnCommand implements Command {
  constructor(
    readonly label: string,
    private readonly doFn: () => void,
    private readonly undoFn: () => void,
  ) {}
  apply(): void {
    this.doFn();
  }
  revert(): void {
    this.undoFn();
  }
}

/** Several commands as one undo step. Reverts in reverse order. */
export class CompositeCommand implements Command {
  constructor(
    readonly label: string,
    private readonly cmds: Command[],
  ) {}
  apply(): void {
    for (const c of this.cmds) c.apply();
  }
  revert(): void {
    for (let i = this.cmds.length - 1; i >= 0; i--) this.cmds[i]!.revert();
  }
}

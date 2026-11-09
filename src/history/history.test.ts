import { describe, expect, it } from 'vitest';
import { CompositeCommand, FnCommand, History } from './history';

function setup() {
  const state = { value: 0, sel: 'a' };
  const log: string[] = [];
  const history = new History<string>(
    {
      getSelection: () => state.sel,
      setSelection: (s) => (state.sel = s),
      onChange: () => log.push('change'),
    },
    3,
  );
  const add = (n: number, selAfter?: string) =>
    new FnCommand(
      `add ${n}`,
      () => {
        state.value += n;
        if (selAfter) state.sel = selAfter;
      },
      () => (state.value -= n),
    );
  return { state, log, history, add };
}

describe('History', () => {
  it('executes, undoes and redoes', () => {
    const { state, history, add } = setup();
    history.execute(add(1));
    history.execute(add(10));
    expect(state.value).toBe(11);
    expect(history.undoLabel).toBe('add 10');
    expect(history.undo()).toBe(true);
    expect(state.value).toBe(1);
    expect(history.redoLabel).toBe('add 10');
    expect(history.redo()).toBe(true);
    expect(state.value).toBe(11);
  });

  it('returns false when there is nothing to undo or redo', () => {
    const { history } = setup();
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('clears the redo stack on a new command', () => {
    const { history, add } = setup();
    history.execute(add(1));
    history.undo();
    history.execute(add(2));
    expect(history.redoLabel).toBeNull();
  });

  it('restores the selection from before/after each command', () => {
    const { state, history, add } = setup();
    history.execute(add(1, 'b'));
    state.sel = 'c'; // a selection change on its own: not recorded
    history.undo();
    expect(state.sel).toBe('a');
    history.redo();
    expect(state.sel).toBe('b');
  });

  it('tracks the dirty state against the last save', () => {
    const { history, add } = setup();
    expect(history.isDirty).toBe(false);
    history.execute(add(1));
    expect(history.isDirty).toBe(true);
    history.markSaved();
    expect(history.isDirty).toBe(false);
    history.undo();
    expect(history.isDirty).toBe(true);
    history.redo();
    expect(history.isDirty).toBe(false);
    // Branching away from the saved state makes it unreachable.
    history.undo();
    history.execute(add(5));
    expect(history.isDirty).toBe(true);
    history.undo();
    expect(history.isDirty).toBe(true);
  });

  it('drops the oldest entries beyond the limit', () => {
    const { state, history, add } = setup();
    for (let i = 1; i <= 5; i++) history.execute(add(i));
    let undone = 0;
    while (history.undo()) undone++;
    expect(undone).toBe(3);
    expect(state.value).toBe(1 + 2);
  });

  it('notifies on every change', () => {
    const { log, history, add } = setup();
    history.execute(add(1));
    history.undo();
    history.redo();
    expect(log).toHaveLength(3);
  });
});

describe('CompositeCommand', () => {
  it('applies in order and reverts in reverse order', () => {
    const order: string[] = [];
    const c = new CompositeCommand('both', [
      new FnCommand('a', () => order.push('do a'), () => order.push('undo a')),
      new FnCommand('b', () => order.push('do b'), () => order.push('undo b')),
    ]);
    c.apply();
    c.revert();
    expect(order).toEqual(['do a', 'do b', 'undo b', 'undo a']);
  });
});

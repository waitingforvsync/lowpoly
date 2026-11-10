import { render } from 'preact';
import { effect } from '@preact/signals';
import { App } from './ui/App';
import { installKeymap } from './editor/keymap';
import { editor } from './editor/editor';
import { installAutosave, restoreAutosave } from './io/autosave';
import './ui/styles.css';

render(<App />, document.getElementById('app')!);
installKeymap();
// Bring back the last session, then keep saving it.
void restoreAutosave().finally(() => installAutosave());

effect(() => {
  void editor.historyVersion.value;
  document.title = `${editor.isDirty ? '● ' : ''}${editor.fileName.value} — Lowpoly`;
});

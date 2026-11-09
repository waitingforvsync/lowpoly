import { Outliner } from './Outliner';
import { Properties } from './Properties';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { ViewportView } from './ViewportView';

export function App() {
  return (
    <div class="app">
      <Toolbar />
      <aside class="sidebar">
        <Outliner />
        <Properties />
      </aside>
      <ViewportView />
      <StatusBar />
    </div>
  );
}

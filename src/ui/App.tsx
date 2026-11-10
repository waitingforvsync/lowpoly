import { Outliner } from './Outliner';
import { Properties } from './Properties';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { ViewportView } from './ViewportView';
import { UVPanel } from './UVPanel';
import { uvPanelOpen } from '../editor/state';

export function App() {
  return (
    <div class={uvPanelOpen.value ? 'app with-uv' : 'app'}>
      <Toolbar />
      <aside class="sidebar">
        <Outliner />
        <Properties />
      </aside>
      <ViewportView />
      {uvPanelOpen.value && <UVPanel />}
      <StatusBar />
    </div>
  );
}

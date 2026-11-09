import { Empty, Panel } from './Panel';

/** Scene outliner. Lists document objects and materials once the document model exists (M2). */
export function Outliner() {
  return (
    <Panel title="Outliner">
      <h3 class="subhead">Objects</h3>
      <Empty>No objects</Empty>
      <h3 class="subhead">Materials</h3>
      <Empty>No materials</Empty>
    </Panel>
  );
}

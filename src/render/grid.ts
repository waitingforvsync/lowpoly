import * as THREE from 'three';
import { COLORS } from './colors';

/**
 * Ground grid on the XY plane (Z-up), with axis lines. Positive axes are solid and negative
 * axes are dashed, as in SketchUp.
 */
export function createGrid(extent = 50, majorEvery = 10): THREE.Group {
  const group = new THREE.Group();
  group.name = 'grid';

  const minor: number[] = [];
  const major: number[] = [];
  for (let i = -extent; i <= extent; i++) {
    if (i === 0) continue; // the axis lines are drawn instead
    const target = i % majorEvery === 0 ? major : minor;
    target.push(i, -extent, 0, i, extent, 0); // parallel to Y
    target.push(-extent, i, 0, extent, i, 0); // parallel to X
  }
  group.add(makeLines(minor, COLORS.gridMinor));
  group.add(makeLines(major, COLORS.gridMajor));

  const axes: [THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), COLORS.axisX],
    [new THREE.Vector3(0, 1, 0), COLORS.axisY],
    [new THREE.Vector3(0, 0, 1), COLORS.axisZ],
  ];
  for (const [dir, color] of axes) {
    const end = dir.clone().multiplyScalar(extent);
    group.add(makeAxisLine(end, color, false));
    group.add(makeAxisLine(end.clone().negate(), color, true));
  }

  return group;
}

function makeLines(positions: number[], color: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
}

function makeAxisLine(end: THREE.Vector3, color: number, dashed: boolean): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]);
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.25 })
    : new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(geometry, material);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 1;
  return line;
}

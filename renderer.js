import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

// ── Toast System ────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// ── Monaco Editor Setup ─────────────────────────────────────────────────

// Register OpenSCAD language
monaco.languages.register({ id: 'scad' });
monaco.languages.setMonarchTokensProvider('scad', {
  keywords: [
    'module', 'function', 'if', 'else', 'for', 'let', 'each',
    'include', 'use', 'true', 'false', 'undef',
  ],
  builtinModules: [
    'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon',
    'linear_extrude', 'rotate_extrude', 'surface', 'import', 'projection',
    'union', 'difference', 'intersection', 'hull', 'minkowski',
    'translate', 'rotate', 'scale', 'mirror', 'multmatrix', 'color', 'offset',
    'resize', 'render', 'children', 'echo', 'assert',
  ],
  builtinFunctions: [
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'abs', 'ceil', 'floor', 'round', 'sqrt', 'pow', 'exp', 'log', 'ln',
    'min', 'max', 'len', 'str', 'chr', 'ord', 'concat', 'lookup',
    'is_undef', 'is_bool', 'is_num', 'is_string', 'is_list',
    'norm', 'cross', 'parent_module', 'search', 'version',
  ],
  operators: ['=', '!', '<', '>', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '?', ':'],
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/\$\w+/, 'variable.predefined'],
      [/\b\d+(\.\d+)?\b/, 'number'],
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@builtinModules': 'type',
          '@builtinFunctions': 'predefined',
          '@default': 'identifier',
        },
      }],
      [/[{}()\[\]]/, '@brackets'],
      [/[;,]/, 'delimiter'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
});

// Register ClawSCAD dark theme
monaco.editor.defineTheme('clawscad-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '44447a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff79c6' },
    { token: 'type', foreground: '8be9fd' },
    { token: 'predefined', foreground: '50fa7b' },
    { token: 'string', foreground: 'f1fa8c' },
    { token: 'number', foreground: 'bd93f9' },
    { token: 'variable.predefined', foreground: 'ffb86c' },
    { token: 'identifier', foreground: 'd0d0e0' },
    { token: 'delimiter', foreground: '6666aa' },
    { token: 'brackets', foreground: '8888bb' },
  ],
  colors: {
    'editor.background': '#0a0a18',
    'editor.foreground': '#d0d0e0',
    'editor.lineHighlightBackground': '#111130',
    'editor.selectionBackground': '#33336655',
    'editorCursor.foreground': '#d0d0e0',
    'editorLineNumber.foreground': '#2a2a55',
    'editorLineNumber.activeForeground': '#4466aa',
    'editor.inactiveSelectionBackground': '#22224444',
  },
});

// Create editor instance
const editorContainer = document.getElementById('editor-container');
const monacoEditor = monaco.editor.create(editorContainer, {
  value: '// Select a checkpoint to view source code',
  language: 'scad',
  theme: 'clawscad-dark',
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  fontFamily: '"JetBrains Mono", Menlo, Monaco, monospace',
  automaticLayout: true,
  lineNumbers: 'on',
  renderLineHighlight: 'line',
  scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  folding: true,
  glyphMargin: false,
  padding: { top: 6 },
  find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never' },
});

// Ctrl+F (find) and Ctrl+H (replace) — open editor and trigger Monaco's built-in actions
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'h')) {
    // Open editor panel if collapsed
    if (editorPanel.classList.contains('collapsed')) {
      editorPanel.classList.remove('collapsed');
    }
    // Focus Monaco and trigger the find/replace action
    monacoEditor.focus();
    if (e.key === 'f') {
      monacoEditor.trigger('keyboard', 'actions.find');
    } else {
      monacoEditor.trigger('keyboard', 'editor.action.startFindReplaceAction');
    }
    e.preventDefault();
  }
});

let editorReadOnly = true;
let currentEditorFile = null;

// Editor panel toggle
const editorPanel = document.getElementById('editor-panel');
const editorToggle = document.getElementById('editor-toggle');
const editorEditToggle = document.getElementById('editor-edit-toggle');
const editorSaveBtn = document.getElementById('editor-save-btn');
const editorFilename = document.getElementById('editor-filename');

editorToggle.addEventListener('click', () => {
  editorPanel.classList.toggle('collapsed');
});

// Checkpoint panel toggle
document.getElementById('checkpoint-toggle').addEventListener('click', () => {
  document.getElementById('checkpoint-panel').classList.toggle('collapsed');
});

editorEditToggle.addEventListener('click', () => {
  editorReadOnly = !editorReadOnly;
  monacoEditor.updateOptions({ readOnly: editorReadOnly });
  editorEditToggle.classList.toggle('active', !editorReadOnly);
  editorSaveBtn.classList.toggle('hidden', editorReadOnly);
});

editorSaveBtn.addEventListener('click', async () => {
  if (!currentEditorFile || editorReadOnly) return;
  const content = monacoEditor.getValue();
  const ok = await window.api.saveFile(currentEditorFile, content);
  if (ok) {
    showToast('File saved', 'success');
  } else {
    showToast('Save failed', 'error');
  }
});

// Receive file content from main process
window.api.onFileContent((data) => {
  currentEditorFile = data.path;
  editorFilename.textContent = data.name;
  monacoEditor.setValue(data.content);
  monacoEditor.revealLine(1);
  // Clear any previous error markers
  const model = monacoEditor.getModel();
  if (model) monaco.editor.setModelMarkers(model, 'openscad', []);
});

// ── Terminal Setup ──────────────────────────────────────────────────────

const term = new Terminal({
  fontSize: 14,
  fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: '#0d0d1a',
    foreground: '#d0d0e0',
    cursor: '#d0d0e0',
    cursorAccent: '#0d0d1a',
    selectionBackground: '#33336688',
    black: '#1a1a2e',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#6272a4',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#d0d0e0',
    brightBlack: '#44447a',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  cursorBlink: true,
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const termEl = document.getElementById('terminal');
term.open(termEl);
fitAddon.fit();
term.focus();
termEl.addEventListener('click', () => term.focus());

window.api.onTerminalData((data) => term.write(data));
term.onData((data) => window.api.sendTerminalInput(data));
term.onResize(({ cols, rows }) => window.api.resizeTerminal(cols, rows));

// ── Second Terminal ─────────────────────────────────────────────────────

let term2 = null;
let fitAddon2 = null;

document.getElementById('add-terminal-btn').addEventListener('click', async () => {
  const pane1 = document.getElementById('terminal-pane-1');
  if (!pane1.classList.contains('hidden')) return; // already open

  pane1.classList.remove('hidden');

  // Create second terminal
  term2 = new Terminal({
    fontSize: 14,
    fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
    theme: term.options.theme,
    cursorBlink: true,
    allowProposedApi: true,
  });
  fitAddon2 = new FitAddon();
  term2.loadAddon(fitAddon2);

  const termEl2 = document.getElementById('terminal-2');
  term2.open(termEl2);
  fitAddon2.fit();
  term2.focus();
  termEl2.addEventListener('click', () => term2.focus());

  window.api.onTerminal2Data((data) => { if (term2) term2.write(data); });
  term2.onData((data) => window.api.sendTerminal2Input(data));
  term2.onResize(({ cols, rows }) => window.api.resizeTerminal2(cols, rows));

  await window.api.spawnTerminal2();

  // Re-fit both terminals
  fitAddon.fit();
  fitAddon2.fit();

  showToast('Second terminal opened', 'info');
});

document.querySelector('.close-terminal-btn').addEventListener('click', async () => {
  await window.api.killTerminal2();
  const pane1 = document.getElementById('terminal-pane-1');
  pane1.classList.add('hidden');
  if (term2) {
    term2.dispose();
    term2 = null;
    fitAddon2 = null;
  }
  fitAddon.fit();
  showToast('Second terminal closed', 'info');
});

// ResizeObserver for terminal 2
const term2Observer = new ResizeObserver(() => {
  if (fitAddon2) fitAddon2.fit();
});
term2Observer.observe(document.getElementById('terminal-2'));

// ── 3D Viewport ─────────────────────────────────────────────────────────

const viewportEl = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10102a);

// Cameras (perspective + orthographic)
const aspect = viewportEl.clientWidth / viewportEl.clientHeight;

const perspCamera = new THREE.PerspectiveCamera(55, aspect, 0.1, 100000);
perspCamera.up.set(0, 0, 1);
perspCamera.position.set(80, -60, 60);

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
orthoCamera.up.set(0, 0, 1);
orthoCamera.position.copy(perspCamera.position);

let activeCamera = perspCamera;
let isOrtho = false;

// Renderer
const renderer3d = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer3d.setSize(viewportEl.clientWidth, viewportEl.clientHeight);
renderer3d.setPixelRatio(window.devicePixelRatio);
renderer3d.toneMapping = THREE.ACESFilmicToneMapping;
renderer3d.toneMappingExposure = 1.2;
viewportEl.appendChild(renderer3d.domElement);

// Environment map for reflections
const pmremGenerator = new THREE.PMREMGenerator(renderer3d);
const envTexture = pmremGenerator.fromScene(new RoomEnvironment()).texture;
scene.environment = envTexture;
pmremGenerator.dispose();

// Controls (one per camera, only one active)
const perspControls = new OrbitControls(perspCamera, renderer3d.domElement);
perspControls.enableDamping = true;
perspControls.dampingFactor = 0.08;
perspControls.enableZoom = true;
perspControls.zoomSpeed = 1.2;
perspControls.enablePan = true;
perspControls.enableRotate = true;
perspControls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
perspControls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.PAN,
};
perspControls.target.set(0, 0, 0);

const orthoControls = new OrbitControls(orthoCamera, renderer3d.domElement);
orthoControls.enableDamping = true;
orthoControls.dampingFactor = 0.08;
orthoControls.enableZoom = true;
orthoControls.zoomSpeed = 1.2;
orthoControls.enablePan = true;
orthoControls.enableRotate = true;
orthoControls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
orthoControls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.PAN,
};
orthoControls.target.set(0, 0, 0);
orthoControls.enabled = false;

let activeControls = perspControls;

// Grid (XY plane — OpenSCAD Z-up convention)
const grid = new THREE.GridHelper(200, 20, 0x2a2a55, 0x1a1a44);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

// Axes
const axes = new THREE.AxesHelper(40);
scene.add(axes);

// Lighting
scene.add(new THREE.AmbientLight(0x606080, 2.0));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(100, -80, 120);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8888cc, 0.6);
fillLight.position.set(-80, 40, 60);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0x4444aa, 0.4);
rimLight.position.set(0, 100, -100);
scene.add(rimLight);

// ── Model Management ────────────────────────────────────────────────────

let currentMesh = null;
let currentEdges = null;
let currentCheckpointId = null;
let edgesVisible = true;
let wireframeMode = false;
let modelBounds = null;
const stlLoader = new STLLoader();

// Cache: checkpointId → { mesh, edges, bounds }
// Keeps all previously loaded models in memory for instant switching.
// Typical STL = a few MB of geometry — even 100 checkpoints is fine.
const modelCache = new Map();

const modelMaterial = new THREE.MeshStandardMaterial({
  color: 0x4488ff,
  roughness: 0.35,
  metalness: 0.15,
  side: THREE.DoubleSide,
});

const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x2244aa,
  transparent: true,
  opacity: 0.3,
});

function removeCurrentFromScene() {
  deselectPart();
  if (currentMesh) scene.remove(currentMesh);
  if (currentEdges) scene.remove(currentEdges);
  currentMesh = null;
  currentEdges = null;
  modelBounds = null;
}

function showCachedModel(checkpointId) {
  const cached = modelCache.get(checkpointId);
  if (!cached) return false;

  removeCurrentFromScene();

  currentMesh = cached.mesh;
  currentEdges = cached.edges;
  modelBounds = cached.bounds;
  currentCheckpointId = checkpointId;

  // Apply current display state
  currentMesh.visible = true;
  if (currentEdges) currentEdges.visible = edgesVisible;
  modelMaterial.wireframe = wireframeMode;

  scene.add(currentMesh);
  if (currentEdges) scene.add(currentEdges);

  fitCameraToModel();
  updateStatus(
    `${modelBounds.size.x.toFixed(1)} x ${modelBounds.size.y.toFixed(1)} x ${modelBounds.size.z.toFixed(1)} mm`
  );
  return true;
}

function validateAndRepairGeometry(geometry) {
  const issues = [];
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) {
    issues.push('empty geometry');
    return issues;
  }

  // Check for NaN/Infinity in positions
  let hasNaN = false;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      hasNaN = true;
      pos.setXYZ(i, 0, 0, 0);
    }
  }
  if (hasNaN) {
    issues.push('NaN vertices fixed');
    pos.needsUpdate = true;
  }

  // Always recompute normals from scratch (STL normals from OpenSCAD are often wrong)
  geometry.computeVertexNormals();

  // Check if normals are all zero (degenerate)
  const norm = geometry.getAttribute('normal');
  if (norm) {
    let allZero = true;
    for (let i = 0; i < Math.min(norm.count, 100); i++) {
      const nx = norm.getX(i), ny = norm.getY(i), nz = norm.getZ(i);
      if (nx !== 0 || ny !== 0 || nz !== 0) { allZero = false; break; }
    }
    if (allZero) {
      issues.push('zero normals');
      // Force flat shading as fallback
      geometry.computeVertexNormals();
    }
  }

  // Compute bounding box to check for degenerate (zero-volume) mesh
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  if (size.x === 0 && size.y === 0 && size.z === 0) {
    issues.push('zero-size mesh');
  } else if (size.x === 0 || size.y === 0 || size.z === 0) {
    issues.push('flat mesh (2D)');
  }

  return issues;
}

function loadSTL(buffer, checkpointId) {
  removeCurrentFromScene();

  // If re-rendering an existing checkpoint, dispose old cached geometry
  if (checkpointId && modelCache.has(checkpointId)) {
    const old = modelCache.get(checkpointId);
    if (old.mesh) old.mesh.geometry.dispose();
    if (old.edges) old.edges.geometry.dispose();
    modelCache.delete(checkpointId);
  }

  let geometry;
  try {
    geometry = stlLoader.parse(
      buffer instanceof Uint8Array ? buffer.buffer : buffer
    );
  } catch (err) {
    showToast(`Failed to parse STL: ${err.message}`, 'error');
    return;
  }

  // Validate and repair geometry
  const issues = validateAndRepairGeometry(geometry);
  if (issues.length > 0) {
    showToast(`Geometry repaired: ${issues.join(', ')}`, 'info');
  }

  // Use a cloned material so color picker changes are per-model
  const mat = modelMaterial.clone();
  const mesh = new THREE.Mesh(geometry, mat);

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  mesh.position.sub(center);

  scene.add(mesh);
  currentMesh = mesh;

  // Edge overlay
  const edgeGeo = new THREE.EdgesGeometry(geometry, 15);
  const edges = new THREE.LineSegments(edgeGeo, edgeMaterial);
  edges.position.copy(mesh.position);
  edges.visible = edgesVisible;
  scene.add(edges);
  currentEdges = edges;

  // Track bounds
  const size = new THREE.Vector3();
  box.getSize(size);
  modelBounds = {
    center: center.clone(),
    size: size.clone(),
    maxDim: Math.max(size.x, size.y, size.z),
  };

  currentCheckpointId = checkpointId;

  // Cache it
  if (checkpointId) {
    modelCache.set(checkpointId, {
      mesh: currentMesh,
      edges: currentEdges,
      bounds: { ...modelBounds },
    });
  }

  // Fit camera
  fitCameraToModel();

  // Apply current wireframe state
  modelMaterial.wireframe = wireframeMode;

  updateStatus(
    `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm`
  );
}

const threeMFLoader = new ThreeMFLoader();

function load3MF(buffer, checkpointId) {
  removeCurrentFromScene();

  // Dispose old cache entry if re-rendering
  if (checkpointId && modelCache.has(checkpointId)) {
    disposeCacheEntry(modelCache.get(checkpointId));
    modelCache.delete(checkpointId);
  }

  const group = threeMFLoader.parse(
    buffer instanceof Uint8Array ? buffer.buffer : buffer
  );

  // Center the group
  const box = new THREE.Box3().setFromObject(group);
  const center = new THREE.Vector3();
  box.getCenter(center);
  group.position.sub(center);

  // Validate, repair, and replace materials on all child meshes.
  // ThreeMFLoader creates MeshPhongMaterial which doesn't work with PBR
  // env map lighting — replace with MeshStandardMaterial clones.
  let repairCount = 0;
  group.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) {
        const issues = validateAndRepairGeometry(child.geometry);
        if (issues.length > 0) repairCount++;
      }
      // Extract any color from the original 3MF material, then replace it
      let origColor = null;
      if (child.material && child.material.color) {
        const hex = child.material.color.getHex();
        // Only keep the color if it's not default white/gray (= no color in 3MF)
        if (hex !== 0xffffff && hex !== 0x000000 && hex !== 0x808080) {
          origColor = child.material.color.clone();
        }
      }
      // Replace with PBR material
      const newMat = modelMaterial.clone();
      if (origColor) newMat.color.copy(origColor);
      child.material = newMat;
    }
  });
  if (repairCount > 0) {
    showToast(`Repaired geometry in ${repairCount} part(s)`, 'info');
  }

  scene.add(group);
  currentMesh = group;
  currentEdges = null; // 3MF models are multi-part, skip edge overlay

  const size = new THREE.Vector3();
  box.getSize(size);
  modelBounds = {
    center: center.clone(),
    size: size.clone(),
    maxDim: Math.max(size.x, size.y, size.z),
  };

  currentCheckpointId = checkpointId;

  if (checkpointId) {
    modelCache.set(checkpointId, {
      mesh: currentMesh,
      edges: null,
      bounds: { ...modelBounds },
      is3MF: true,
    });
  }

  fitCameraToModel();
  updateStatus(
    `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm (color)`
  );
}

function disposeCacheEntry(entry) {
  if (!entry) return;
  if (entry.mesh) {
    if (entry.mesh.isMesh) {
      entry.mesh.geometry.dispose();
    } else if (entry.mesh.isGroup) {
      entry.mesh.traverse((c) => { if (c.isMesh) c.geometry.dispose(); });
    }
  }
  if (entry.edges) entry.edges.geometry.dispose();
}

function fitCameraToModel() {
  if (!modelBounds) return;
  const d = modelBounds.maxDim * 1.2;
  setCameraView(
    new THREE.Vector3(d, -d * 0.7, d * 0.8),
    new THREE.Vector3(0, 0, 0)
  );
}

// ── Camera Animation ────────────────────────────────────────────────────

let cameraTarget = null;
const LERP_SPEED = 0.1;

function setCameraView(position, lookAt) {
  cameraTarget = {
    position: position.clone(),
    lookAt: lookAt.clone(),
  };
}

function setCameraViewInstant(position, lookAt) {
  activeCamera.position.copy(position);
  activeControls.target.copy(lookAt);
  if (isOrtho) syncOrthoFrustum();
  activeControls.update();
  cameraTarget = null;
}

// ── View Presets ────────────────────────────────────────────────────────

function getViewDistance() {
  return modelBounds ? modelBounds.maxDim * 1.4 : 80;
}

const VIEW_PRESETS = {
  front: () => {
    const d = getViewDistance();
    setCameraView(new THREE.Vector3(0, -d, 0), new THREE.Vector3(0, 0, 0));
  },
  back: () => {
    const d = getViewDistance();
    setCameraView(new THREE.Vector3(0, d, 0), new THREE.Vector3(0, 0, 0));
  },
  right: () => {
    const d = getViewDistance();
    setCameraView(new THREE.Vector3(d, 0, 0), new THREE.Vector3(0, 0, 0));
  },
  left: () => {
    const d = getViewDistance();
    setCameraView(new THREE.Vector3(-d, 0, 0), new THREE.Vector3(0, 0, 0));
  },
  top: () => {
    const d = getViewDistance();
    setCameraView(new THREE.Vector3(0, -0.01, d), new THREE.Vector3(0, 0, 0));
  },
  bottom: () => {
    const d = getViewDistance();
    setCameraView(new THREE.Vector3(0, 0.01, -d), new THREE.Vector3(0, 0, 0));
  },
  iso: () => {
    const d = getViewDistance();
    setCameraView(
      new THREE.Vector3(d, -d * 0.7, d * 0.8),
      new THREE.Vector3(0, 0, 0)
    );
  },
};

// ── Orthographic Camera ─────────────────────────────────────────────────

function syncOrthoFrustum() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (w === 0 || h === 0) return;
  const a = w / h;
  const dist = orthoCamera.position.distanceTo(orthoControls.target);
  const halfH = dist * Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2));
  orthoCamera.left = -halfH * a;
  orthoCamera.right = halfH * a;
  orthoCamera.top = halfH;
  orthoCamera.bottom = -halfH;
  orthoCamera.updateProjectionMatrix();
}

function toggleProjection() {
  if (isOrtho) {
    perspCamera.position.copy(orthoCamera.position);
    perspControls.target.copy(orthoControls.target);
    perspControls.enabled = true;
    orthoControls.enabled = false;
    activeCamera = perspCamera;
    activeControls = perspControls;
    isOrtho = false;
  } else {
    orthoCamera.position.copy(perspCamera.position);
    orthoControls.target.copy(perspControls.target);
    syncOrthoFrustum();
    orthoControls.enabled = true;
    perspControls.enabled = false;
    activeCamera = orthoCamera;
    activeControls = orthoControls;
    isOrtho = true;
  }
  activeControls.update();
  updateToolbarState();
  showToast(isOrtho ? 'Orthographic projection' : 'Perspective projection');
}

// ── Viewport Toolbar ────────────────────────────────────────────────────

const TOOLBAR_BUTTONS = [
  {
    id: 'btn-render',
    title: 'Re-render (F5)',
    icon: 'Render',
    className: 'toolbar-btn render-btn render-text-btn',
    action: () => {
      window.api.forceRender();
      showToast('Rendering...', 'info');
    },
  },
  {
    id: 'btn-reset',
    title: 'Reset View (R)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 3v3M10 3L7 6M10 3l3 3"/><circle cx="10" cy="12" r="5"/><circle cx="10" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    action: () => VIEW_PRESETS.iso(),
  },
  {
    id: 'btn-fit',
    title: 'Zoom to Fit (F)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"/></svg>`,
    action: () => fitCameraToModel(),
  },
  {
    id: 'btn-wire',
    title: 'Wireframe (W)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="1"/><path d="M10 3v14M3 10h14"/></svg>`,
    toggle: true,
    action: () => {
      wireframeMode = !wireframeMode;
      modelMaterial.wireframe = wireframeMode;
      // Also apply to 3MF multi-material models
      if (currentMesh && currentMesh.isGroup) {
        currentMesh.traverse((c) => {
          if (c.isMesh && c.material) c.material.wireframe = wireframeMode;
        });
      }
      updateToolbarState();
    },
  },
  {
    id: 'btn-edges',
    title: 'Toggle Edges (E)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 15l5-10 5 10M6.5 12h7"/></svg>`,
    toggle: true,
    active: true,
    action: () => {
      edgesVisible = !edgesVisible;
      if (currentEdges) currentEdges.visible = edgesVisible;
      updateToolbarState();
    },
  },
  {
    id: 'btn-ortho',
    title: 'Ortho/Perspective (O)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 14l4-2V6l4-2 4 2v6l-4 2-4-2"/><path d="M8 12l4 2M12 4v6"/></svg>`,
    toggle: true,
    action: toggleProjection,
  },
  {
    id: 'btn-zoom-in',
    title: 'Zoom In (+)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M10 7v6M7 10h6"/></svg>`,
    action: () => {
      const dir = new THREE.Vector3()
        .subVectors(activeControls.target, activeCamera.position)
        .normalize();
      activeCamera.position.addScaledVector(dir, getViewDistance() * 0.15);
      activeControls.update();
    },
  },
  {
    id: 'btn-zoom-out',
    title: 'Zoom Out (-)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M7 10h6"/></svg>`,
    action: () => {
      const dir = new THREE.Vector3()
        .subVectors(activeControls.target, activeCamera.position)
        .normalize();
      activeCamera.position.addScaledVector(dir, -getViewDistance() * 0.15);
      activeControls.update();
    },
  },
  {
    id: 'btn-screenshot',
    title: 'Screenshot (S)',
    icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="16" height="11" rx="1.5"/><circle cx="10" cy="11" r="3"/><path d="M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1"/></svg>`,
    action: () => {
      renderer3d.render(scene, activeCamera);
      const link = document.createElement('a');
      link.download = `clawscad-${Date.now()}.png`;
      link.href = renderer3d.domElement.toDataURL('image/png');
      link.click();
      showToast('Screenshot saved', 'success');
    },
  },
];

// Left toolbar: render, zoom in, zoom out
// Right toolbar: reset, fit, wireframe, edges, ortho, screenshot
const LEFT_BUTTONS = ['btn-render', 'btn-zoom-in', 'btn-zoom-out'];

function buildToolbar() {
  const toolbarL = document.getElementById('viewport-toolbar-left');
  const toolbarR = document.getElementById('viewport-toolbar-right');
  for (const btn of TOOLBAR_BUTTONS) {
    const el = document.createElement('button');
    el.id = btn.id;
    el.className = (btn.className || 'toolbar-btn') + (btn.active ? ' active' : '');
    el.title = btn.title;
    el.innerHTML = btn.icon;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.action();
    });
    if (LEFT_BUTTONS.includes(btn.id)) {
      toolbarL.appendChild(el);
    } else {
      toolbarR.appendChild(el);
    }
  }
}

function updateToolbarState() {
  const wire = document.getElementById('btn-wire');
  const edges = document.getElementById('btn-edges');
  const ortho = document.getElementById('btn-ortho');
  if (wire) wire.classList.toggle('active', wireframeMode);
  if (edges) edges.classList.toggle('active', edgesVisible);
  if (ortho) ortho.classList.toggle('active', isOrtho);
}

// View preset buttons
function buildViewPresets() {
  const container = document.getElementById('view-presets');
  const presets = [
    { key: 'front', label: 'F', title: 'Front (1)' },
    { key: 'back', label: 'Bk', title: 'Back (2)' },
    { key: 'right', label: 'R', title: 'Right (3)' },
    { key: 'left', label: 'L', title: 'Left (4)' },
    { key: 'top', label: 'T', title: 'Top (5)' },
    { key: 'bottom', label: 'Bt', title: 'Bottom (6)' },
    { key: 'iso', label: 'Iso', title: 'Isometric (7)' },
  ];
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = p.label;
    btn.title = p.title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      VIEW_PRESETS[p.key]();
    });
    container.appendChild(btn);
  }
}

buildToolbar();
buildViewPresets();

// ── Rendering Overlay ───────────────────────────────────────────────────

const renderOverlay = document.getElementById('render-overlay');
const renderTimeEl = document.getElementById('render-time');
let renderTimer = null;
let renderStartTime = 0;

function showRenderOverlay(filename) {
  // Remove current model from scene during render (cached objects stay in memory)
  removeCurrentFromScene();

  renderOverlay.classList.add('visible');
  renderOverlay.querySelector('.overlay-text').textContent =
    `Rendering ${filename || ''}...`;
  renderStartTime = Date.now();
  renderTimeEl.textContent = '0:00';
  updateRenderTimer();
  renderTimer = setInterval(updateRenderTimer, 1000);
}

function hideRenderOverlay() {
  renderOverlay.classList.remove('visible');
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
}

function showRenderError(error) {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
  renderOverlay.querySelector('.overlay-text').textContent = 'Render Failed';
  renderTimeEl.textContent = error.substring(0, 120);
  renderOverlay.querySelector('.spinner').style.display = 'none';
  renderOverlay.querySelector('.overlay-bar').style.display = 'none';
  // Auto-hide after 5s
  setTimeout(() => {
    hideRenderOverlay();
    // Restore spinner for next render
    renderOverlay.querySelector('.spinner').style.display = '';
    renderOverlay.querySelector('.overlay-bar').style.display = '';
  }, 5000);
}

function updateRenderTimer() {
  const elapsed = Math.floor((Date.now() - renderStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  renderTimeEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ── IPC Handlers ────────────────────────────────────────────────────────

window.api.onRenderStart((data) => {
  showRenderOverlay(data.file);
});

window.api.onRenderComplete((data) => {
  hideRenderOverlay();
  showToast(`Rendered ${data.file}`, 'success');
});

window.api.onRenderError((data) => {
  showRenderError(data.error);
  showToast(`Render failed: ${data.file}`, 'error');

  // Set Monaco error markers if editor has the file loaded
  if (data.errors && data.errors.length > 0) {
    const model = monacoEditor.getModel();
    if (model) {
      const markers = data.errors
        .filter((e) => e.line > 0)
        .map((e) => ({
          severity: monaco.MarkerSeverity.Error,
          message: e.message,
          startLineNumber: e.line,
          startColumn: 1,
          endLineNumber: e.line,
          endColumn: model.getLineMaxColumn(e.line),
        }));
      monaco.editor.setModelMarkers(model, 'openscad', markers);
    }
  }
});

window.api.onRenderWarning((data) => {
  showToast(`Warning: ${data.file}`, 'info');
});

window.api.onModelUpdate((update) => {
  if (update.data) {
    hideRenderOverlay();
    const bytes =
      update.data instanceof Uint8Array
        ? update.data
        : new Uint8Array(update.data);
    const cpId = update.checkpointId || null;
    if (update.format === '3mf') {
      load3MF(bytes, cpId);
    } else {
      loadSTL(bytes, cpId);
    }
  }
});

// ── Checkpoint Tree ─────────────────────────────────────────────────────

const treeEl = document.getElementById('checkpoint-tree');
let checkpointState = { checkpoints: {}, active: null };
const collapsedNodes = new Set(); // checkpoint IDs whose children are hidden
let contextMenuTargetId = null;

function renderTree() {
  const { checkpoints, active } = checkpointState;
  treeEl.innerHTML = '';

  if (Object.keys(checkpoints).length === 0) {
    treeEl.innerHTML =
      '<div class="cp-empty">No checkpoints yet.<br>Ask Claude to create a model!</div>';
    return;
  }

  // Build adjacency
  const children = {};
  const roots = [];
  for (const [id, cp] of Object.entries(checkpoints)) {
    if (!cp.parent || !checkpoints[cp.parent]) {
      roots.push(id);
    } else {
      if (!children[cp.parent]) children[cp.parent] = [];
      children[cp.parent].push(id);
    }
  }

  const sortByTime = (ids) =>
    ids.sort(
      (a, b) =>
        new Date(checkpoints[a].created) - new Date(checkpoints[b].created)
    );

  function renderNode(id, depth, isLastFlags) {
    const cp = checkpoints[id];
    const isActive = id === active;
    const isRoot = depth === 0;

    const node = document.createElement('div');
    node.className = 'cp-node' + (isActive ? ' active' : '');
    node.dataset.id = id;
    node.dataset.depth = depth;

    // Tree prefix with box-drawing characters
    if (depth > 0) {
      const pre = document.createElement('span');
      pre.className = 'cp-prefix';
      let str = '';
      for (let i = 0; i < depth - 1; i++) {
        str += isLastFlags[i] ? '   ' : '\u2502  ';
      }
      str += isLastFlags[depth - 1] ? '\u2514\u2500 ' : '\u251C\u2500 ';
      pre.textContent = str;
      node.appendChild(pre);
    }

    const dot = document.createElement('span');
    dot.className = 'cp-dot' + (isRoot ? ' root' : '');
    node.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'cp-label';
    label.textContent = cp.label || cp.file;
    node.appendChild(label);

    const time = document.createElement('span');
    time.className = 'cp-time';
    const d = new Date(cp.created);
    time.textContent = d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    node.appendChild(time);

    node.addEventListener('click', () => {
      window.api.selectCheckpoint(id);
    });

    // Right-click context menu
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextMenuTargetId = id;
      const menu = document.getElementById('cp-context-menu');

      // Update menu items based on node state
      const hasKids = (children[id] || []).length > 0;
      const collapseItem = menu.querySelector('[data-action="collapse"]');
      collapseItem.textContent = collapsedNodes.has(id) ? 'Expand Children' : 'Collapse Children';
      collapseItem.style.display = hasKids ? '' : 'none';

      const sessionItem = menu.querySelector('[data-action="resume-session"]');
      sessionItem.style.display = cp.sessionId ? '' : 'none';

      menu.classList.remove('hidden');
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';

      // Keep in viewport
      requestAnimationFrame(() => {
        const mr = menu.getBoundingClientRect();
        if (mr.right > window.innerWidth - 8) menu.style.left = (window.innerWidth - mr.width - 8) + 'px';
        if (mr.bottom > window.innerHeight - 8) menu.style.top = (window.innerHeight - mr.height - 8) + 'px';
      });
    });

    // Tooltip on hover
    node.addEventListener('mouseenter', (e) => {
      const desc = cp.description || '';
      const meta = [cp.file];
      if (cp.sessionId) meta.push('session linked');
      const d2 = new Date(cp.created);
      meta.push(d2.toLocaleString());

      const tooltip = document.getElementById('cp-tooltip');
      document.getElementById('cp-tooltip-desc').textContent = desc;
      document.getElementById('cp-tooltip-meta').textContent = meta.join(' \u00b7 ');
      tooltip.classList.remove('hidden');

      const rect = node.getBoundingClientRect();
      tooltip.style.left = rect.right + 8 + 'px';
      tooltip.style.top = rect.top + 'px';

      // Keep tooltip in viewport
      const tr = tooltip.getBoundingClientRect();
      if (tr.right > window.innerWidth - 8) {
        tooltip.style.left = rect.left - tr.width - 8 + 'px';
      }
      if (tr.bottom > window.innerHeight - 8) {
        tooltip.style.top = window.innerHeight - tr.height - 8 + 'px';
      }
    });

    node.addEventListener('mouseleave', () => {
      document.getElementById('cp-tooltip').classList.add('hidden');
    });

    // Show collapse indicator if has children
    const hasKids = (children[id] || []).length > 0;
    if (hasKids) {
      const collapseIcon = document.createElement('span');
      collapseIcon.className = 'cp-collapse-icon';
      collapseIcon.textContent = collapsedNodes.has(id) ? '\u25B6' : '\u25BC';
      collapseIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsedNodes.has(id)) collapsedNodes.delete(id);
        else collapsedNodes.add(id);
        renderTree();
      });
      node.appendChild(collapseIcon);
    }

    treeEl.appendChild(node);

    // Render children (unless collapsed)
    if (!collapsedNodes.has(id)) {
      const kids = children[id] || [];
      sortByTime(kids);
      for (let i = 0; i < kids.length; i++) {
        renderNode(kids[i], depth + 1, [
          ...isLastFlags,
          i === kids.length - 1,
        ]);
      }
    }
  }

  sortByTime(roots);
  for (const root of roots) {
    renderNode(root, 0, []);
  }
}

// ── Inline Rename & Delete Confirm ───────────────────────────────────────

function showRenameInput(cpId, currentName) {
  // Find the node in the tree and replace the label with an input
  const node = treeEl.querySelector(`.cp-node[data-id="${cpId}"]`);
  if (!node) return;

  const labelEl = node.querySelector('.cp-label');
  if (!labelEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cp-rename-input';
  input.value = currentName;
  input.maxLength = 30;

  labelEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    if (val && val !== currentName) {
      window.api.renameCheckpoint(cpId, val.substring(0, 30));
      showToast(`Renamed to "${val}"`, 'success');
    } else {
      // Re-render tree to restore original
      renderTree();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { renderTree(); }
  });
  input.addEventListener('blur', commit);
}

function showDeleteConfirm(cpId, name) {
  // Show a small inline confirmation bar at the top of the checkpoint tree
  const bar = document.createElement('div');
  bar.className = 'cp-delete-bar';
  bar.innerHTML = `
    <span>Delete "${name}"?</span>
    <button class="cp-delete-yes">Delete</button>
    <button class="cp-delete-no">Cancel</button>
  `;
  treeEl.prepend(bar);

  bar.querySelector('.cp-delete-yes').addEventListener('click', () => {
    window.api.deleteCheckpoint(cpId);
    showToast('Checkpoint deleted', 'info');
    bar.remove();
  });
  bar.querySelector('.cp-delete-no').addEventListener('click', () => {
    bar.remove();
  });
}

// ── Checkpoint Context Menu Actions ──────────────────────────────────────

const cpContextMenu = document.getElementById('cp-context-menu');

// Close context menu on click anywhere
document.addEventListener('click', () => {
  cpContextMenu.classList.add('hidden');
});

cpContextMenu.addEventListener('click', async (e) => {
  const action = e.target.closest('.ctx-item')?.dataset.action;
  if (!action || !contextMenuTargetId) return;
  cpContextMenu.classList.add('hidden');

  const id = contextMenuTargetId;
  const cp = checkpointState.checkpoints[id];
  contextMenuTargetId = null;

  switch (action) {
    case 'rename': {
      showRenameInput(id, cp?.label || cp?.file || '');
      break;
    }
    case 'delete': {
      showDeleteConfirm(id, cp?.label || cp?.file || '');
      break;
    }
    case 'collapse': {
      if (collapsedNodes.has(id)) collapsedNodes.delete(id);
      else collapsedNodes.add(id);
      renderTree();
      break;
    }
    case 'view-source': {
      window.api.selectCheckpoint(id);
      editorPanel.classList.remove('collapsed');
      break;
    }
    case 'resume-session': {
      if (cp?.sessionId) {
        const ok = await window.api.restoreCheckpointSession(id);
        if (ok) showToast('Resuming session from this checkpoint', 'info');
        else showToast('No linked session', 'error');
      }
      break;
    }
    case 'branch-here': {
      window.api.selectCheckpoint(id);
      showToast(`Branching from "${cp?.label || cp?.file}" — next model will be a child`, 'info');
      break;
    }
  }
});

// Resume session button in checkpoint header
const resumeSessionBtn = document.getElementById('resume-session-btn');
resumeSessionBtn.addEventListener('click', async () => {
  if (!checkpointState.active) return;
  const ok = await window.api.restoreCheckpointSession(checkpointState.active);
  if (ok) {
    showToast('Resuming conversation from this checkpoint', 'info');
  } else {
    showToast('No linked session for this checkpoint', 'error');
  }
});

function updateResumeButton() {
  const cp =
    checkpointState.active &&
    checkpointState.checkpoints[checkpointState.active];
  if (cp && cp.sessionId) {
    resumeSessionBtn.classList.remove('hidden');
  } else {
    resumeSessionBtn.classList.add('hidden');
  }
}

window.api.onCheckpointUpdate((state) => {
  checkpointState = state;
  renderTree();
  updateResumeButton();

  // Refresh viewport 2's tree if open
  if (viewport2 && viewport2._cpListener) viewport2._cpListener();

  // Instant model switch if we have this checkpoint cached
  if (state.active && state.active !== currentCheckpointId) {
    if (showCachedModel(state.active)) {
      hideRenderOverlay();
    }
  }
});

window.api.getCheckpoints().then((state) => {
  checkpointState = state;
  renderTree();
});

// ── Session Browser ─────────────────────────────────────────────────────

const sessionBtn = document.getElementById('session-btn');
const sessionDropdown = document.getElementById('session-dropdown');
const sessionList = document.getElementById('session-list');

sessionBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const isHidden = sessionDropdown.classList.contains('hidden');
  if (isHidden) {
    sessionDropdown.classList.remove('hidden');
    await loadSessions();
  } else {
    sessionDropdown.classList.add('hidden');
  }
});

// Close dropdown when clicking elsewhere
document.addEventListener('click', (e) => {
  if (!sessionDropdown.contains(e.target) && e.target !== sessionBtn) {
    sessionDropdown.classList.add('hidden');
  }
});

document.getElementById('session-new').addEventListener('click', () => {
  window.api.newSession();
  sessionDropdown.classList.add('hidden');
  showToast('New session started', 'info');
});

document.getElementById('session-continue').addEventListener('click', () => {
  window.api.continueSession();
  sessionDropdown.classList.add('hidden');
  showToast('Continuing last session', 'info');
});

async function loadSessions() {
  const sessions = await window.api.getSessions();
  sessionList.innerHTML = '';

  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="session-empty">No previous sessions</div>';
    return;
  }

  for (const s of sessions.slice(0, 20)) {
    const item = document.createElement('div');
    item.className = 'session-item';

    const dateEl = document.createElement('div');
    dateEl.className = 'session-item-date';
    const d = new Date(s.date);
    dateEl.textContent = d.toLocaleDateString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const msgEl = document.createElement('div');
    msgEl.className = 'session-item-msg';
    msgEl.textContent = s.firstMessage || '(empty session)';

    item.appendChild(dateEl);
    item.appendChild(msgEl);
    item.addEventListener('click', () => {
      window.api.resumeSession(s.sessionId);
      sessionDropdown.classList.add('hidden');
      showToast('Resuming session', 'info');
    });

    sessionList.appendChild(item);
  }
}

// ── Status Bar ──────────────────────────────────────────────────────────

const statusEl = document.getElementById('status');
function updateStatus(msg) {
  statusEl.textContent = msg;
}

// Workspace path in header — show ~ instead of full home path
let homeDirPrefix = '';
function prettyPath(p) {
  if (homeDirPrefix && p.startsWith(homeDirPrefix)) {
    return '~' + p.slice(homeDirPrefix.length);
  }
  return p;
}

window.api.getWorkspace().then((ws) => {
  // Detect home dir from the workspace path
  const match = ws.match(/^(\/home\/[^/]+|\/root)/);
  if (match) homeDirPrefix = match[1];
  const pathEl = document.getElementById('workspace-path');
  if (pathEl) pathEl.textContent = prettyPath(ws);
});

// ── App Menu ────────────────────────────────────────────────────────────

const appMenuBtn = document.getElementById('app-menu-btn');
const appMenu = document.getElementById('app-menu');

appMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  appMenu.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!appMenu.contains(e.target) && !appMenuBtn.contains(e.target)) {
    appMenu.classList.add('hidden');
  }
});

appMenu.addEventListener('click', async (e) => {
  const action = e.target.closest('.menu-item')?.dataset.action;
  if (!action) return;
  appMenu.classList.add('hidden');

  switch (action) {
    case 'split-viewport':
      addSecondViewport();
      break;
    case 'new-project':
      window.api.newProjectWindow();
      break;
    case 'open-workspace': {
      const ws = await window.api.openWorkspace();
      if (ws) {
        document.getElementById('workspace-path').textContent = prettyPath(ws);
        showToast(`Opened ${ws}`, 'success');
      }
      break;
    }
    case 'open-in-files':
      window.api.openInFiles();
      break;
    case 'screenshot':
      document.getElementById('btn-screenshot').click();
      break;
    case 'toggle-editor':
      editorPanel.classList.toggle('collapsed');
      break;
    case 'reset-view':
      VIEW_PRESETS.iso();
      break;
    case 'zoom-fit':
      fitCameraToModel();
      break;
    case 'toggle-wireframe':
      document.getElementById('btn-wire').click();
      break;
    case 'toggle-ortho':
      document.getElementById('btn-ortho').click();
      break;
    case 'devtools':
      window.api.toggleDevTools();
      break;
  }
});

// ── Color Swatches ──────────────────────────────────────────────────────

const defaultSwatches = ['#4488ff', '#ff5555', '#50fa7b', '#f1fa8c', '#ff79c6', '#8be9fd'];
let swatchColors = JSON.parse(localStorage.getItem('clawscad-swatches') || 'null') || [...defaultSwatches];
const swatchEditor = document.getElementById('swatch-editor');
let editingSwatch = null;

// Initialize swatch backgrounds from saved colors
document.querySelectorAll('.swatch').forEach((el, i) => {
  if (swatchColors[i]) el.style.background = swatchColors[i];
});

function applyColorToModel(hex) {
  const color = new THREE.Color(hex);
  if (currentMesh) {
    if (currentMesh.isMesh) {
      currentMesh.material.color.copy(color);
    } else if (currentMesh.isGroup) {
      currentMesh.traverse((c) => {
        if (c.isMesh && c.material && c.material.color) {
          c.material.color.copy(color);
        }
      });
    }
    showToast(`Color: ${hex}`, 'info');
  }
}

document.getElementById('color-swatches').addEventListener('click', (e) => {
  const swatch = e.target.closest('.swatch');
  if (!swatch) return;
  const idx = parseInt(swatch.dataset.idx);
  applyColorToModel(swatchColors[idx]);
});

document.getElementById('color-swatches').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const swatch = e.target.closest('.swatch');
  if (!swatch) return;
  editingSwatch = parseInt(swatch.dataset.idx);
  swatchEditor.value = swatchColors[editingSwatch];
  swatchEditor.classList.remove('hidden');
  swatchEditor.click(); // Open the native color picker
});

swatchEditor.addEventListener('input', (e) => {
  if (editingSwatch === null) return;
  const hex = e.target.value;
  swatchColors[editingSwatch] = hex;
  const swatch = document.querySelector(`.swatch[data-idx="${editingSwatch}"]`);
  if (swatch) swatch.style.background = hex;
  localStorage.setItem('clawscad-swatches', JSON.stringify(swatchColors));
});

swatchEditor.addEventListener('change', () => {
  swatchEditor.classList.add('hidden');
  editingSwatch = null;
});

// ── Export Buttons ──────────────────────────────────────────────────────

document.querySelectorAll('[data-export]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const format = btn.dataset.export;
    showToast(`Exporting ${format.toUpperCase()}...`, 'info');
    const result = await window.api.exportModel(format);
    if (result && result.path) {
      showToast(`Exported to ${result.path}`, 'success');
    } else if (result && result.error) {
      showToast(`Export failed: ${result.error.substring(0, 80)}`, 'error');
    }
  });
});

// ── Path Bar Dropdown ───────────────────────────────────────────────────

const wsPathBtn = document.getElementById('workspace-path-btn');
const wsDropdown = document.getElementById('workspace-dropdown');
const wsPathInput = document.getElementById('ws-path-input');
const wsRecentList = document.getElementById('ws-recent-list');
const wsFileBrowser = document.getElementById('ws-file-browser');
const wsBrowserPath = document.getElementById('ws-browser-path');
const wsBrowserList = document.getElementById('ws-browser-list');

wsPathBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const isHidden = wsDropdown.classList.contains('hidden');
  if (isHidden) {
    wsDropdown.classList.remove('hidden');
    wsPathInput.value = '';
    wsPathInput.focus();
    wsFileBrowser.classList.add('hidden');
    await loadRecentPaths();
  } else {
    wsDropdown.classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  if (!wsDropdown.contains(e.target) && !wsPathBtn.contains(e.target)) {
    wsDropdown.classList.add('hidden');
  }
});

async function loadRecentPaths() {
  const paths = await window.api.listRecentPaths();
  wsRecentList.innerHTML = '';
  if (paths.length === 0) {
    wsRecentList.innerHTML = '<div style="padding:12px;color:#333360;font-size:11px;text-align:center">No recent workspaces</div>';
    return;
  }
  for (const p of paths) {
    const item = document.createElement('div');
    item.className = 'ws-recent-item';
    item.textContent = p;
    item.addEventListener('click', () => openPathFromDropdown(p));
    wsRecentList.appendChild(item);
  }
}

document.getElementById('ws-path-go').addEventListener('click', () => {
  const input = wsPathInput.value.trim();
  if (input) openPathFromDropdown(input);
});

wsPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const input = wsPathInput.value.trim();
    if (input) openPathFromDropdown(input);
  }
});

async function openPathFromDropdown(inputPath) {
  // First check if it's a directory — browse it
  const browseResult = await window.api.browseDir(inputPath);
  if (browseResult) {
    showFileBrowser(browseResult);
    return;
  }

  // Otherwise try to open it (file or workspace)
  const result = await window.api.openPath(inputPath);
  if (result) {
    wsDropdown.classList.add('hidden');
    if (result.type === 'workspace') {
      document.getElementById('workspace-path').textContent = prettyPath(result.path);
      showToast(`Opened workspace: ${result.path}`, 'success');
    } else {
      showToast(`Imported ${result.path}`, 'success');
    }
  } else {
    showToast('Invalid path', 'error');
  }
}

function showFileBrowser(browseResult) {
  wsFileBrowser.classList.remove('hidden');
  wsBrowserPath.textContent = browseResult.dir;
  wsBrowserList.innerHTML = '';

  for (const entry of browseResult.entries) {
    const item = document.createElement('div');
    item.className = 'ws-file-item' + (entry.isDir ? ' dir' : ' scad');
    item.textContent = entry.name;
    item.addEventListener('click', async () => {
      if (entry.isDir) {
        const sub = await window.api.browseDir(entry.path);
        if (sub) showFileBrowser(sub);
      } else {
        // It's a .scad file — open the parent as workspace
        const parentDir = browseResult.dir;
        const result = await window.api.openPath(parentDir);
        wsDropdown.classList.add('hidden');
        if (result) {
          document.getElementById('workspace-path').textContent = prettyPath(parentDir);
          showToast(`Opened workspace: ${parentDir}`, 'success');
        }
      }
    });
    wsBrowserList.appendChild(item);
  }
}

// ── Global Keyboard Shortcuts ────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    addSecondViewport();
  }
  if (e.key === 'F5') {
    e.preventDefault();
    window.api.forceRender();
    showToast('Rendering...', 'info');
  }
});

// ── Splitter ────────────────────────────────────────────────────────────

const splitter = document.getElementById('splitter');
const leftPanel = document.getElementById('left-panel');
const rightPanel = document.getElementById('right-panel');
let dragging = false;

splitter.addEventListener('mousedown', (e) => {
  dragging = true;
  splitter.classList.add('active');
  document.body.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const mainContent = document.getElementById('main-content');
  const rect = mainContent.getBoundingClientRect();
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  const clamped = Math.max(20, Math.min(75, pct));
  leftPanel.style.flex = 'none';
  leftPanel.style.width = clamped + '%';
  rightPanel.style.flex = '1';
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    splitter.classList.remove('active');
    document.body.classList.remove('dragging');
  }
});

// ── Object Picking & Properties ──────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
let selectedMesh = null;
let selectionOutline = null;

// Print settings (persisted in localStorage)
const MATERIAL_DENSITY = { PLA: 1.24, ABS: 1.04, PETG: 1.27 };
let printSettings = {
  infillPercent: 15,
  material: 'PLA',
  costPerKg: 20,
  ...JSON.parse(localStorage.getItem('clawscad-print-settings') || '{}'),
};

function savePrintSettings() {
  localStorage.setItem('clawscad-print-settings', JSON.stringify(printSettings));
}

// Hydrate settings UI from saved values
document.getElementById('setting-infill').value = printSettings.infillPercent;
document.getElementById('setting-material').value = printSettings.material;
document.getElementById('setting-cost').value = printSettings.costPerKg;

document.getElementById('setting-infill').addEventListener('change', (e) => {
  printSettings.infillPercent = parseFloat(e.target.value) || 15;
  savePrintSettings();
  if (selectedMesh) refreshPropsPanel(selectedMesh);
});
document.getElementById('setting-material').addEventListener('change', (e) => {
  printSettings.material = e.target.value;
  savePrintSettings();
  if (selectedMesh) refreshPropsPanel(selectedMesh);
});
document.getElementById('setting-cost').addEventListener('change', (e) => {
  printSettings.costPerKg = parseFloat(e.target.value) || 20;
  savePrintSettings();
  if (selectedMesh) refreshPropsPanel(selectedMesh);
});

document.getElementById('part-props-settings-btn').addEventListener('click', () => {
  document.getElementById('part-props-settings').classList.toggle('hidden');
});
document.getElementById('part-props-close').addEventListener('click', () => {
  deselectPart();
});

function pickObject(e) {
  if (!currentMesh) return;

  const rect = renderer3d.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouseNDC, activeCamera);

  const targets = currentMesh.isGroup ? currentMesh.children : [currentMesh];
  const intersects = raycaster.intersectObjects(targets, true);

  if (intersects.length > 0) {
    const hit = intersects[0].object;
    if (hit.isMesh) {
      selectPart(hit);
      return;
    }
  }
  deselectPart();
}

function selectPart(mesh) {
  deselectPart(); // clear previous
  selectedMesh = mesh;

  // Highlight with emissive glow
  if (mesh.material) {
    mesh.userData._origEmissive = mesh.material.emissive
      ? mesh.material.emissive.getHex()
      : 0;
    if (mesh.material.emissive) {
      mesh.material.emissive.setHex(0x1a1a44);
    }
  }

  // Show properties panel
  refreshPropsPanel(mesh);
  document.getElementById('part-props').classList.remove('hidden');
}

function deselectPart() {
  if (selectedMesh && selectedMesh.material && selectedMesh.material.emissive) {
    selectedMesh.material.emissive.setHex(
      selectedMesh.userData._origEmissive || 0
    );
  }
  selectedMesh = null;
  document.getElementById('part-props').classList.add('hidden');
}

function refreshPropsPanel(mesh) {
  const geo = mesh.geometry;
  if (!geo) return;

  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);

  const triangles = geo.index
    ? geo.index.count / 3
    : geo.getAttribute('position').count / 3;
  const volumeMM3 = computeVolume(geo);
  const surfaceMM2 = computeSurfaceArea(geo);
  const volumeCM3 = volumeMM3 / 1000;
  const surfaceCM2 = surfaceMM2 / 100;

  // Cost estimation
  const density = MATERIAL_DENSITY[printSettings.material] || 1.24;
  const infill = printSettings.infillPercent / 100;
  // Effective volume: infill core + ~15% overhead for walls/top/bottom
  const effectiveVolCM3 = volumeCM3 * (infill + 0.15);
  const weightG = effectiveVolCM3 * density;
  const cost = (weightG / 1000) * printSettings.costPerKg;

  // Part name
  const name = mesh.name || (currentMesh && currentMesh.isGroup
    ? `Part ${Array.from(currentMesh.children).indexOf(mesh) + 1}`
    : 'Model');

  // Color
  let colorStr = '';
  if (mesh.material && mesh.material.color) {
    colorStr = '#' + mesh.material.color.getHexString();
  }

  document.getElementById('part-props-title').textContent = name;

  const body = document.getElementById('part-props-body');
  body.innerHTML = '';

  const rows = [
    ['Dimensions', `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm`],
    ['Volume', `${volumeCM3.toFixed(2)} cm\u00b3`],
    ['Surface', `${surfaceCM2.toFixed(1)} cm\u00b2`],
    ['Triangles', triangles.toLocaleString()],
    ['Weight', `${weightG.toFixed(1)} g (${printSettings.material})`],
    ['Filament', `${(weightG / density / Math.PI / (0.0875 * 0.0875) / 100).toFixed(2)} m`],
    ['Est. Cost', `$${cost.toFixed(2)}`, true],
  ];
  for (const [key, val, hl] of rows) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    row.innerHTML = `<span class="prop-key">${key}</span><span class="prop-val${hl ? ' highlight' : ''}">${val}</span>`;
    body.appendChild(row);
  }

  // Color picker row (interactive)
  if (mesh.material && mesh.material.color) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const keySpan = document.createElement('span');
    keySpan.className = 'prop-key';
    keySpan.textContent = 'Color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = colorStr || '#4488ff';
    colorInput.className = 'prop-color-input';
    colorInput.addEventListener('input', (e) => {
      const c = new THREE.Color(e.target.value);
      mesh.material.color.copy(c);
      if (mesh.material.needsUpdate !== undefined) mesh.material.needsUpdate = true;
    });
    row.appendChild(keySpan);
    row.appendChild(colorInput);
    body.appendChild(row);
  }
}

// ── Geometry Analysis ─────────────────────────────────────────────────

function computeVolume(geometry) {
  const pos = geometry.getAttribute('position');
  const idx = geometry.getIndex();
  let volume = 0;
  const va = new THREE.Vector3(),
    vb = new THREE.Vector3(),
    vc = new THREE.Vector3();

  const addTri = () => {
    // Signed volume of tetrahedron formed by triangle + origin
    volume +=
      (va.x * (vb.y * vc.z - vb.z * vc.y) -
        vb.x * (va.y * vc.z - va.z * vc.y) +
        vc.x * (va.y * vb.z - va.z * vb.y)) /
      6;
  };

  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      va.fromBufferAttribute(pos, idx.getX(i));
      vb.fromBufferAttribute(pos, idx.getX(i + 1));
      vc.fromBufferAttribute(pos, idx.getX(i + 2));
      addTri();
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      va.fromBufferAttribute(pos, i);
      vb.fromBufferAttribute(pos, i + 1);
      vc.fromBufferAttribute(pos, i + 2);
      addTri();
    }
  }
  return Math.abs(volume);
}

function computeSurfaceArea(geometry) {
  const pos = geometry.getAttribute('position');
  const idx = geometry.getIndex();
  let area = 0;
  const va = new THREE.Vector3(),
    vb = new THREE.Vector3(),
    vc = new THREE.Vector3();
  const ab = new THREE.Vector3(),
    ac = new THREE.Vector3();

  const addTri = () => {
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    area += ab.cross(ac).length() * 0.5;
  };

  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      va.fromBufferAttribute(pos, idx.getX(i));
      vb.fromBufferAttribute(pos, idx.getX(i + 1));
      vc.fromBufferAttribute(pos, idx.getX(i + 2));
      addTri();
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      va.fromBufferAttribute(pos, i);
      vb.fromBufferAttribute(pos, i + 1);
      vc.fromBufferAttribute(pos, i + 2);
      addTri();
    }
  }
  return area;
}

// ── Keyboard Shortcuts ──────────────────────────────────────────────────

viewportEl.addEventListener('keydown', (e) => {
  // Only handle when viewport is focused
  switch (e.key) {
    case '1': VIEW_PRESETS.front(); break;
    case '2': VIEW_PRESETS.back(); break;
    case '3': VIEW_PRESETS.right(); break;
    case '4': VIEW_PRESETS.left(); break;
    case '5': VIEW_PRESETS.top(); break;
    case '6': VIEW_PRESETS.bottom(); break;
    case '7': VIEW_PRESETS.iso(); break;
    case 'r': case 'R': VIEW_PRESETS.iso(); break;
    case 'f': case 'F': fitCameraToModel(); break;
    case 'w': case 'W':
      wireframeMode = !wireframeMode;
      modelMaterial.wireframe = wireframeMode;
      updateToolbarState();
      break;
    case 'e': case 'E':
      edgesVisible = !edgesVisible;
      if (currentEdges) currentEdges.visible = edgesVisible;
      updateToolbarState();
      break;
    case 'o': case 'O': toggleProjection(); break;
    case 's': case 'S':
      if (!e.ctrlKey) {
        document.getElementById('btn-screenshot').click();
      }
      break;
    case '+': case '=':
      document.getElementById('btn-zoom-in').click();
      break;
    case '-': case '_':
      document.getElementById('btn-zoom-out').click();
      break;
    case 'Escape':
      deselectPart();
      break;
    case 'F5':
      window.api.forceRender();
      showToast('Rendering...', 'info');
      break;
    default: return;
  }
  e.preventDefault();
});

// Click viewport: focus + object picking
viewportEl.addEventListener('click', (e) => {
  viewportEl.focus();
  // Don't pick if clicking toolbar/preset buttons
  if (e.target !== renderer3d.domElement) return;
  pickObject(e);
});

// ── Resize Handling ─────────────────────────────────────────────────────

const viewportObserver = new ResizeObserver(() => {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (w > 0 && h > 0) {
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
    if (isOrtho) syncOrthoFrustum();
    renderer3d.setSize(w, h);
  }
});
viewportObserver.observe(viewportEl);

const termObserver = new ResizeObserver(() => {
  fitAddon.fit();
});
termObserver.observe(termEl);

// ── Second Viewport (split view, shares the same scene) ─────────────────

let viewport2 = null;

function addSecondViewport() {
  if (viewport2) {
    showToast('Second viewport already open', 'info');
    return;
  }

  // Build a complete viewport column: 3D view + toolbar + presets + status + editor + history
  const mainContent = document.getElementById('main-content');
  const splitter = document.getElementById('splitter');

  const col = document.createElement('div');
  col.id = 'viewport2-column';
  col.className = 'viewport-column';

  // --- 3D viewport pane ---
  const pane = document.createElement('div');
  pane.className = 'viewport-pane';
  pane.tabIndex = 0;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'viewport-close-btn';
  closeBtn.innerHTML = '\u00d7';
  closeBtn.title = 'Close viewport';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeSecondViewport(); });
  pane.appendChild(closeBtn);

  // Left toolbar (render, zoom)
  const tbL = document.createElement('div');
  tbL.className = 'vp2-toolbar-left';
  pane.appendChild(tbL);

  // Right toolbar (reset, fit, wire, edges, screenshot)
  const tbR = document.createElement('div');
  tbR.className = 'vp2-toolbar-right';
  pane.appendChild(tbR);

  // View presets
  const presets = document.createElement('div');
  presets.className = 'vp2-view-presets';
  pane.appendChild(presets);

  // Render overlay
  const overlay = document.createElement('div');
  overlay.className = 'vp2-render-overlay';
  overlay.innerHTML = '<div class="overlay-content"><div class="spinner"></div><div class="overlay-text">Rendering...</div></div>';
  pane.appendChild(overlay);

  col.appendChild(pane);

  // --- Status bar ---
  const statusBar = document.createElement('div');
  statusBar.className = 'vp2-status-bar';
  statusBar.innerHTML = '<span class="label">VIEWPORT 2</span> <span class="vp2-status">Select a checkpoint</span>';
  col.appendChild(statusBar);

  // --- Source editor (read-only pre with syntax coloring) ---
  const editorPanel = document.createElement('div');
  editorPanel.className = 'vp2-editor-panel collapsed';
  editorPanel.innerHTML = `
    <div class="vp2-editor-header">
      <button class="panel-toggle vp2-editor-toggle"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4 4 4-4"/></svg></button>
      <span class="label">Source</span>
      <span class="vp2-editor-filename"></span>
    </div>
    <pre class="vp2-editor-content"></pre>`;
  editorPanel.querySelector('.vp2-editor-toggle').addEventListener('click', () => {
    editorPanel.classList.toggle('collapsed');
  });
  col.appendChild(editorPanel);

  // --- Checkpoint tree ---
  const cpPanel = document.createElement('div');
  cpPanel.className = 'vp2-checkpoint-panel';
  cpPanel.innerHTML = `
    <div class="vp2-checkpoint-header">
      <button class="panel-toggle vp2-cp-toggle"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4 4 4-4"/></svg></button>
      <span class="label">History</span>
    </div>
    <div class="vp2-checkpoint-tree"></div>`;
  cpPanel.querySelector('.vp2-cp-toggle').addEventListener('click', () => {
    cpPanel.classList.toggle('collapsed');
  });
  col.appendChild(cpPanel);

  // Insert before the main splitter
  mainContent.insertBefore(col, splitter);

  // Also add a splitter between left-panel and this column
  const midSplitter = document.createElement('div');
  midSplitter.id = 'splitter-mid';
  midSplitter.className = 'splitter-v';
  mainContent.insertBefore(midSplitter, col);

  // --- Three.js scene (independent, not shared) ---
  const v2scene = new THREE.Scene();
  v2scene.background = new THREE.Color(0x10102a);

  const pmrem2 = new THREE.PMREMGenerator(new THREE.WebGLRenderer({ antialias: false }));
  const env2 = pmrem2.fromScene(new RoomEnvironment()).texture;
  v2scene.environment = env2;
  pmrem2.dispose();

  // Grid, axes, lights (duplicated — lightweight)
  const grid2 = new THREE.GridHelper(200, 20, 0x2a2a55, 0x1a1a44);
  grid2.rotation.x = Math.PI / 2;
  v2scene.add(grid2);
  v2scene.add(new THREE.AxesHelper(40));
  v2scene.add(new THREE.AmbientLight(0x606080, 2.0));
  const kl2 = new THREE.DirectionalLight(0xffffff, 1.5);
  kl2.position.set(100, -80, 120);
  v2scene.add(kl2);
  const fl2 = new THREE.DirectionalLight(0x8888cc, 0.6);
  fl2.position.set(-80, 40, 60);
  v2scene.add(fl2);

  // Renderer
  const r2 = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r2.setPixelRatio(window.devicePixelRatio);
  r2.toneMapping = THREE.ACESFilmicToneMapping;
  r2.toneMappingExposure = 1.2;
  pane.appendChild(r2.domElement);
  r2.setSize(pane.clientWidth || 400, pane.clientHeight || 400);

  // Camera + controls
  const cam2 = new THREE.PerspectiveCamera(55, (pane.clientWidth || 400) / (pane.clientHeight || 400), 0.1, 100000);
  cam2.up.set(0, 0, 1);
  cam2.position.set(-80, 60, 60);

  const ctrl2 = new OrbitControls(cam2, r2.domElement);
  ctrl2.enableDamping = true;
  ctrl2.dampingFactor = 0.08;
  ctrl2.enableZoom = true;
  ctrl2.target.set(0, 0, 0);

  // Resize
  const resObs = new ResizeObserver(() => {
    const pw = pane.clientWidth, ph = pane.clientHeight;
    if (pw > 0 && ph > 0) { cam2.aspect = pw / ph; cam2.updateProjectionMatrix(); r2.setSize(pw, ph); }
  });
  resObs.observe(pane);

  // Model state for viewport 2
  const v2 = {
    el: col,
    pane, midSplitter,
    scene: v2scene, renderer: r2, camera: cam2, controls: ctrl2,
    resizeObs: resObs,
    currentMesh: null, currentEdges: null, modelBounds: null,
    selectedCpId: null,
    treeEl: cpPanel.querySelector('.vp2-checkpoint-tree'),
    statusEl: statusBar.querySelector('.vp2-status'),
    editorContent: editorPanel.querySelector('.vp2-editor-content'),
    editorFilename: editorPanel.querySelector('.vp2-editor-filename'),
    overlay,
  };

  // --- Toolbar buttons ---
  function v2SetCameraView(pos) {
    cam2.position.set(pos.x, pos.y, pos.z);
    ctrl2.target.set(0, 0, 0);
    ctrl2.update();
  }
  function v2dist() { return v2.modelBounds ? v2.modelBounds.maxDim * 1.4 : 80; }

  const leftBtns = [
    { label: 'Render', cls: 'toolbar-btn render-btn render-text-btn', action: () => window.api.forceRender() },
    { label: '+', cls: 'toolbar-btn', action: () => { const d = new THREE.Vector3().subVectors(ctrl2.target, cam2.position).normalize(); cam2.position.addScaledVector(d, v2dist() * 0.15); ctrl2.update(); }},
    { label: '\u2212', cls: 'toolbar-btn', action: () => { const d = new THREE.Vector3().subVectors(ctrl2.target, cam2.position).normalize(); cam2.position.addScaledVector(d, -v2dist() * 0.15); ctrl2.update(); }},
  ];
  const rightBtns = [
    { label: 'Iso', cls: 'toolbar-btn', action: () => { const d = v2dist(); v2SetCameraView(new THREE.Vector3(d, -d*0.7, d*0.8)); }},
    { label: 'Fit', cls: 'toolbar-btn', action: () => { if (v2.modelBounds) { const d = v2.modelBounds.maxDim * 1.2; v2SetCameraView(new THREE.Vector3(d, -d*0.7, d*0.8)); }}},
    { label: 'W', cls: 'toolbar-btn', action: () => { if (v2.currentMesh) { const m = v2.currentMesh.isMesh ? v2.currentMesh : v2.currentMesh.children?.find(c => c.isMesh); if (m) m.material.wireframe = !m.material.wireframe; }}},
  ];
  for (const b of leftBtns) { const el = document.createElement('button'); el.className = b.cls; el.textContent = b.label; el.addEventListener('click', (e) => { e.stopPropagation(); b.action(); }); tbL.appendChild(el); }
  for (const b of rightBtns) { const el = document.createElement('button'); el.className = b.cls; el.textContent = b.label; el.addEventListener('click', (e) => { e.stopPropagation(); b.action(); }); tbR.appendChild(el); }

  // View presets
  for (const [key, px, py, pz] of [['F',0,-1,0],['Bk',0,1,0],['R',1,0,0],['L',-1,0,0],['T',0,0,1],['Bt',0,0,-1]]) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = key;
    btn.addEventListener('click', (e) => { e.stopPropagation(); const d = v2dist(); v2SetCameraView(new THREE.Vector3(px*d, py*d + (pz===0?-0.01:0), pz*d)); });
    presets.appendChild(btn);
  }

  // --- Checkpoint tree rendering ---
  function renderV2Tree() {
    const { checkpoints } = checkpointState;
    v2.treeEl.innerHTML = '';
    if (Object.keys(checkpoints).length === 0) {
      v2.treeEl.innerHTML = '<div class="cp-empty">No checkpoints</div>';
      return;
    }
    const children2 = {};
    const roots2 = [];
    for (const [id, cp] of Object.entries(checkpoints)) {
      if (!cp.parent || !checkpoints[cp.parent]) roots2.push(id);
      else { if (!children2[cp.parent]) children2[cp.parent] = []; children2[cp.parent].push(id); }
    }
    const sort2 = (ids) => ids.sort((a, b) => new Date(checkpoints[a].created) - new Date(checkpoints[b].created));

    function renderN2(id, depth, flags) {
      const cp = checkpoints[id];
      const node = document.createElement('div');
      node.className = 'cp-node' + (id === v2.selectedCpId ? ' active' : '');
      if (depth > 0) {
        const pre = document.createElement('span');
        pre.className = 'cp-prefix';
        let s = '';
        for (let i = 0; i < depth-1; i++) s += flags[i] ? '   ' : '\u2502  ';
        s += flags[depth-1] ? '\u2514\u2500 ' : '\u251C\u2500 ';
        pre.textContent = s;
        node.appendChild(pre);
      }
      const dot = document.createElement('span');
      dot.className = 'cp-dot' + (depth === 0 ? ' root' : '');
      node.appendChild(dot);
      const lbl = document.createElement('span');
      lbl.className = 'cp-label';
      lbl.textContent = cp.label || cp.file;
      node.appendChild(lbl);
      node.addEventListener('click', () => v2SelectCheckpoint(id));
      v2.treeEl.appendChild(node);

      const kids = children2[id] || [];
      sort2(kids);
      for (let i = 0; i < kids.length; i++) renderN2(kids[i], depth+1, [...flags, i === kids.length-1]);
    }

    sort2(roots2);
    for (const r of roots2) renderN2(r, 0, []);
  }

  // --- Select a checkpoint in viewport 2 ---
  async function v2SelectCheckpoint(id) {
    const cp = checkpointState.checkpoints[id];
    if (!cp) return;
    v2.selectedCpId = id;
    renderV2Tree();

    // Load source code
    const scadPath = await window.api.getWorkspace() + '/' + cp.file;
    const content = await window.api.readFile(scadPath);
    v2.editorFilename.textContent = cp.file;
    v2.editorContent.textContent = content || '// Could not read file';

    // Load model — check for 3MF then STL
    const basePath = scadPath.replace(/\.scad$/, '');
    let modelData = null;
    let format = 'stl';

    for (const [ext, fmt] of [['.3mf', '3mf'], ['.stl', 'stl']]) {
      const data = await window.api.readFile(basePath + ext);
      // readFile returns string for text files — we need binary
      // Fall back to the main process render flow
      if (data !== null) { format = fmt; break; }
    }

    // Request the main process to send us the model data
    // Use the existing checkpoint:select which sends model:update
    // But that would change the primary viewport. Instead, load from file via IPC.
    v2.statusEl.textContent = `Loading ${cp.file}...`;

    // Direct file read for binary model — use a special IPC
    const result = await window.api.readModelFile(basePath + (format === '3mf' ? '.3mf' : '.stl'), format);
    if (result && result.data) {
      v2LoadModel(result.data, format);
      v2.statusEl.textContent = cp.label || cp.file;
    } else {
      v2.statusEl.textContent = 'No rendered model — select in primary viewport first';
    }
  }

  function v2LoadModel(buffer, format) {
    // Remove old model
    if (v2.currentMesh) { v2scene.remove(v2.currentMesh); }
    if (v2.currentEdges) { v2scene.remove(v2.currentEdges); }

    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let mesh;

    if (format === '3mf') {
      const group = new ThreeMFLoader().parse(bytes.buffer);
      const box = new THREE.Box3().setFromObject(group);
      const center = new THREE.Vector3();
      box.getCenter(center);
      group.position.sub(center);
      group.traverse((c) => {
        if (c.isMesh) {
          const issues = validateAndRepairGeometry(c.geometry);
          c.material = modelMaterial.clone();
        }
      });
      mesh = group;
      const size = new THREE.Vector3(); box.getSize(size);
      v2.modelBounds = { maxDim: Math.max(size.x, size.y, size.z), size };
    } else {
      const geo = new STLLoader().parse(bytes.buffer);
      const issues = validateAndRepairGeometry(geo);
      mesh = new THREE.Mesh(geo, modelMaterial.clone());
      geo.computeBoundingBox();
      const box = geo.boundingBox;
      const center = new THREE.Vector3(); box.getCenter(center);
      mesh.position.sub(center);
      const size = new THREE.Vector3(); box.getSize(size);
      v2.modelBounds = { maxDim: Math.max(size.x, size.y, size.z), size };
    }

    v2scene.add(mesh);
    v2.currentMesh = mesh;

    // Fit camera
    const d = v2.modelBounds.maxDim * 1.2;
    cam2.position.set(d, -d*0.7, d*0.8);
    ctrl2.target.set(0, 0, 0);
    ctrl2.update();
  }

  // Initial tree render
  renderV2Tree();

  // Listen for checkpoint updates to re-render tree
  v2._cpListener = () => renderV2Tree();

  // Splitter drag for mid splitter
  let midDragging = false;
  midSplitter.addEventListener('mousedown', (e) => { midDragging = true; e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('mousemove', (e) => {
    if (!midDragging) return;
    const mc = document.getElementById('main-content');
    const rect = mc.getBoundingClientRect();
    const leftPanel = document.getElementById('left-panel');
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(15, Math.min(50, pct));
    leftPanel.style.flex = 'none';
    leftPanel.style.width = clamped + '%';
  });
  document.addEventListener('mouseup', () => { if (midDragging) { midDragging = false; document.body.classList.remove('dragging'); }});

  viewport2 = v2;
  showToast('Second viewport opened — click a checkpoint to load a model', 'info');
}

function removeSecondViewport() {
  if (!viewport2) return;
  viewport2.controls.dispose();
  viewport2.renderer.dispose();
  viewport2.resizeObs.disconnect();
  viewport2.midSplitter.remove();
  viewport2.el.remove();
  // Reset left panel width
  document.getElementById('left-panel').style.width = '';
  document.getElementById('left-panel').style.flex = '1';
  viewport2 = null;
  showToast('Viewport closed', 'info');
}

// ── Render Loop ─────────────────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);

  // Primary viewport
  if (cameraTarget) {
    activeCamera.position.lerp(cameraTarget.position, LERP_SPEED);
    activeControls.target.lerp(cameraTarget.lookAt, LERP_SPEED);

    if (activeCamera.position.distanceTo(cameraTarget.position) < 0.05) {
      activeCamera.position.copy(cameraTarget.position);
      activeControls.target.copy(cameraTarget.lookAt);
      cameraTarget = null;
    }
    if (isOrtho) syncOrthoFrustum();
  }

  activeControls.update();
  renderer3d.render(scene, activeCamera);

  // Second viewport (shares the same scene, independent camera)
  if (viewport2) {
    viewport2.activeCtrl.update();
    viewport2.renderer.render(scene, viewport2.activeCam);
  }
}

animate();

import { MAP_CONFIGS, LINE_STYLES } from './data/lines.js';
import { MapDataStore } from './data/store.js';
import { ImagePixelAnalyzer } from './engine/autodetect.js';
import { MRTSimulator } from './engine/simulator.js';
import { CalibrationController } from './engine/calibration.js';

// DOM Elements
const bgImage = document.getElementById('bg-image');
const canvas = document.getElementById('simCanvas');
const mapViewport = document.getElementById('map-viewport');
const stageContainer = document.getElementById('stage-container');
const imgStatus = document.getElementById('img-status');
const telemetry = document.getElementById('telemetry');

const stationCard = document.getElementById('station-card');
const cardName = document.getElementById('card-name');
const cardLines = document.getElementById('card-lines');
const cardDirection = document.getElementById('card-direction');
const cardStatus = document.getElementById('card-status');
const cardCoords = document.getElementById('card-coords');

const calibrationDrawer = document.getElementById('calibration-drawer');
const toggleCalibrateBtn = document.getElementById('toggleCalibrateBtn');
const seqBanner = document.getElementById('seq-banner');
const seqBannerText = document.getElementById('seq-banner-text');
const selectedStnInfo = document.getElementById('selectedStnInfo');
const calLineSelect = document.getElementById('calLineSelect');
const soloLineCheck = document.getElementById('soloLineCheck');

// Core Instances
const store = new MapDataStore();
const analyzer = new ImagePixelAnalyzer();
const simulator = new MRTSimulator(canvas, store);

// Custom uploaded image DataURLs per map
const customMapImages = {};

// Zoom & Pan State
let zoomLevel = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;

function updateViewportTransform() {
  mapViewport.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
  document.getElementById('zoomLabel').innerText = `${Math.round(zoomLevel * 100)}%`;
}

function updateTelemetry(customMessage = null) {
  const stats = simulator.buildNetwork(true);
  if (customMessage) {
    telemetry.innerText = `${customMessage} | TRAINS: ${stats.trains} | LEDS: ${stats.leds}`;
  } else {
    telemetry.innerText = `ACTIVE TRAINS: ${stats.trains} | TOTAL LED NODES: ${stats.leds} | STATIONS: ${stats.stations}`;
  }

  // Update Sequential Banner
  if (calibration.sequentialMode) {
    const stations = store.getLines(simulator.currentMap)[calibration.seqLineKey] || [];
    const stn = stations[calibration.seqIndex];
    if (stn) {
      seqBanner.classList.add('visible');
      seqBannerText.innerText = `Click map to place [${calibration.seqLineKey}] (${calibration.seqIndex + 1}/${stations.length}): ${stn.name}`;
    } else {
      seqBanner.classList.remove('visible');
    }
  } else {
    seqBanner.classList.remove('visible');
  }

  // Update Selected Station Readout
  const sel = simulator.selectedStation;
  if (sel) {
    const liveStn = store.getLines(simulator.currentMap)[sel.lineKey]?.[sel.stationIdx];
    const xStr = liveStn ? liveStn.x.toFixed(4) : sel.x.toFixed(4);
    const yStr = liveStn ? liveStn.y.toFixed(4) : sel.y.toFixed(4);
    selectedStnInfo.innerText = `Selected: [${sel.lineKey}] ${sel.name} (${xStr}, ${yStr})`;
  } else {
    selectedStnInfo.innerText = 'Selected: None (Click any station dot)';
  }
}

const calibration = new CalibrationController(simulator, store, analyzer, updateTelemetry);

// ============================================================================
// IMAGE LOADING WITH FALLBACK PATHS
// ============================================================================
let candidateIdx = 0;
let currentCandidates = [];

function tryLoadMapImage(mapId) {
  simulator.imageLoaded = false;
  bgImage.style.display = 'none';

  if (customMapImages[mapId]) {
    currentCandidates = [customMapImages[mapId]];
  } else {
    currentCandidates = MAP_CONFIGS[mapId]?.candidatePaths || [];
  }
  candidateIdx = 0;

  if (currentCandidates.length > 0) {
    bgImage.src = currentCandidates[0];
  }
}

bgImage.addEventListener('load', () => {
  simulator.imageLoaded = true;
  bgImage.style.display = 'block';
  const rawW = bgImage.naturalWidth || 1360;
  const rawH = bgImage.naturalHeight || 860;
  const minTargetWidth = 1600;
  const upscale = rawW < minTargetWidth ? minTargetWidth / rawW : 1;
  canvas.width = Math.round(rawW * upscale);
  canvas.height = Math.round(rawH * upscale);

  const hasPixels = analyzer.loadImage(bgImage, canvas.width, canvas.height);
  const pixelTag = hasPixels ? 'PIXEL SNAP READY' : 'IMAGE LOADED';
  imgStatus.innerText = `MAP: ${simulator.currentMap.toUpperCase()} (${canvas.width}x${canvas.height}px) | ${pixelTag}`;
});

bgImage.addEventListener('error', () => {
  candidateIdx++;
  if (candidateIdx < currentCandidates.length) {
    bgImage.src = currentCandidates[candidateIdx];
    return;
  }
  simulator.imageLoaded = false;
  bgImage.style.display = 'none';
  canvas.width = 1360;
  canvas.height = 860;
  const expectedFile = MAP_CONFIGS[simulator.currentMap]?.filename || 'map image';
  imgStatus.innerText = `VECTOR BACKDROP (Place "${expectedFile}" in project folder or click "📁 Load Image")`;
});

// File Upload & Drag-and-Drop
const imgUpload = document.getElementById('imgUpload');
document.getElementById('uploadBtn').addEventListener('click', () => imgUpload.click());

function handleImageFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    customMapImages[simulator.currentMap] = e.target.result;
    tryLoadMapImage(simulator.currentMap);
  };
  reader.readAsDataURL(file);
}

imgUpload.addEventListener('change', (e) => handleImageFile(e.target.files[0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    if (file.name.endsWith('.json')) {
      handleJsonFile(file);
    } else {
      handleImageFile(file);
    }
  }
});

// ============================================================================
// POINTER & CANVAS INTERACTION
// ============================================================================
function getNormalizedCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const normX = (e.clientX - rect.left) / rect.width;
  const normY = (e.clientY - rect.top) / rect.height;
  return { normX, normY };
}

canvas.addEventListener('pointerdown', (e) => {
  // Middle click or Alt/Space + click pans the viewport
  if (e.button === 1 || e.altKey) {
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  const { normX, normY } = getNormalizedCanvasCoords(e);
  if (calibration.handlePointerDown(normX, normY, e)) {
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (isPanning) {
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    updateViewportTransform();
    return;
  }

  const { normX, normY } = getNormalizedCanvasCoords(e);

  if (calibration.handlePointerMove(normX, normY, e)) {
    return;
  }

  // Hover detection for station card
  const hovered = simulator.findNearestStation(normX, normY, 13);
  simulator.hoveredStation = hovered;

  if (hovered) {
    cardName.innerText = hovered.name;
    const lineMeta = LINE_STYLES[hovered.lineKey];
    cardLines.innerText = lineMeta?.name || hovered.lineKey;
    cardLines.style.color = lineMeta?.color || '#fff';

    const activeTrain = simulator.getTrainAtStation(hovered);
    if (activeTrain && lineMeta?.dirNames) {
      const dirStr = lineMeta.dirNames[activeTrain.dir] || `Direction ${activeTrain.dir}`;
      cardDirection.innerText = `🚆 ${dirStr}`;
      cardStatus.innerText = activeTrain.dwell > 0
        ? '🟢 Train dwelling at platform'
        : '🟡 Train approaching / departing';
    } else if (lineMeta?.dirNames) {
      cardDirection.innerText = `Directions: ${lineMeta.dirNames['1']} | ${lineMeta.dirNames['-1']}`;
      cardStatus.innerText = '⚪ Standing by';
    } else {
      cardDirection.innerText = '';
      cardStatus.innerText = '';
    }

    cardCoords.innerText = `x: ${hovered.x.toFixed(4)}, y: ${hovered.y.toFixed(4)}`;
    stationCard.classList.add('visible');
  } else {
    stationCard.classList.remove('visible');
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (isPanning) {
    isPanning = false;
    return;
  }
  const { normX, normY } = getNormalizedCanvasCoords(e);
  calibration.handlePointerUp(normX, normY, e);
});

// Wheel Zoom on Stage
stageContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  zoomLevel = Math.max(0.6, Math.min(6.0, zoomLevel * factor));
  updateViewportTransform();
}, { passive: false });

document.getElementById('zoomInBtn').addEventListener('click', () => {
  zoomLevel = Math.min(6.0, zoomLevel * 1.2);
  updateViewportTransform();
});
document.getElementById('zoomOutBtn').addEventListener('click', () => {
  zoomLevel = Math.max(0.6, zoomLevel / 1.2);
  updateViewportTransform();
});
document.getElementById('zoomResetBtn').addEventListener('click', () => {
  zoomLevel = 1.0;
  panX = 0;
  panY = 0;
  updateViewportTransform();
});

// ============================================================================
// TOOLBAR & CALIBRATION CONTROLS
// ============================================================================
document.getElementById('opacitySlider').addEventListener('input', (e) => {
  bgImage.style.opacity = e.target.value / 100;
});

const speedSlider = document.getElementById('speedSlider');
const speedVal = document.getElementById('speedVal');
if (speedSlider && speedVal) {
  simulator.trainSpeedMultiplier = Number(speedSlider.value);
  speedSlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    simulator.trainSpeedMultiplier = val;
    speedVal.innerText = `${val.toFixed(1)}x`;
  });
}

document.getElementById('ledModeSelect').addEventListener('change', (e) => {
  simulator.ledMode = e.target.value;
});

document.getElementById('midLedSelect').addEventListener('change', (e) => {
  simulator.intermediateCount = Number(e.target.value);
  updateTelemetry();
});

document.getElementById('labelModeSelect').addEventListener('change', (e) => {
  simulator.labelMode = e.target.value;
});

document.getElementById('dirFilterSelect').addEventListener('change', (e) => {
  simulator.directionFilter = e.target.value;
  updateTelemetry();
});

const toggleTracksBtn = document.getElementById('toggleTracksBtn');
toggleTracksBtn.addEventListener('click', () => {
  simulator.showTrackLines = !simulator.showTrackLines;
  toggleTracksBtn.innerText = `Tracks: ${simulator.showTrackLines ? 'ON' : 'OFF'}`;
});

// Map Switcher
document.querySelectorAll('[data-map]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-map]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mapId = btn.dataset.map;
    simulator.setMap(mapId);
    tryLoadMapImage(mapId);
    updateTelemetry();
  });
});

// Calibration Drawer Toggle
toggleCalibrateBtn.addEventListener('click', () => {
  const isOpen = calibrationDrawer.classList.toggle('open');
  toggleCalibrateBtn.classList.toggle('active', isOpen);
  calibration.setEnabled(isOpen);
});

calLineSelect.addEventListener('change', () => {
  const val = calLineSelect.value;
  if (soloLineCheck.checked) {
    simulator.soloLine = val;
  }
  if (calibration.sequentialMode && val !== 'ALL') {
    calibration.startSequentialMode(val, 0);
  }
});

soloLineCheck.addEventListener('change', () => {
  simulator.soloLine = soloLineCheck.checked ? calLineSelect.value : 'ALL';
});

document.getElementById('linkInterchangeCheck').addEventListener('change', (e) => {
  calibration.linkInterchanges = e.target.checked;
});

const snapRadiusSlider = document.getElementById('snapRadiusSlider');
const snapRadiusVal = document.getElementById('snapRadiusVal');
snapRadiusSlider.addEventListener('input', (e) => {
  calibration.snapRadiusPx = Number(e.target.value);
  snapRadiusVal.innerText = `${calibration.snapRadiusPx}px`;
});

document.getElementById('autoSnapDropCheck').addEventListener('change', (e) => {
  calibration.autoSnapOnDrop = e.target.checked;
});

// Auto-Snap Line Button
document.getElementById('autoSnapLineBtn').addEventListener('click', () => {
  if (!analyzer.hasPixels()) {
    updateTelemetry('LOAD MAP IMAGE FIRST TO USE PIXEL AUTO-SNAP');
    return;
  }
  const targetLine = calLineSelect.value;
  const count = analyzer.snapLineStations(
    store,
    simulator.currentMap,
    targetLine,
    calibration.snapRadiusPx,
    calibration.linkInterchanges
  );
  updateTelemetry(`AUTO-SNAPPED ${count} STATIONS ON ${targetLine}`);
});

// Auto-Detect & Fit Circle Line Ring
document.getElementById('autoFitCircleBtn').addEventListener('click', () => {
  let geom = analyzer.detectCircleLineGeometry();
  if (!geom) {
    geom = store.getMapData(simulator.currentMap)?.circleGeometry || {
      cx: 0.495,
      cy: 0.58,
      rx: 0.17,
      ry: 0.21
    };
  }
  store.fitCircleLineToEllipse(simulator.currentMap, geom, calibration.linkInterchanges);
  updateTelemetry(`FITTED CIRCLE LINE RING (cx:${geom.cx}, cy:${geom.cy})`);
});

// Sequential Click-to-Place Controls
document.getElementById('startSeqBtn').addEventListener('click', () => {
  const targetLine = calLineSelect.value === 'ALL' ? 'EWL' : calLineSelect.value;
  calLineSelect.value = targetLine;
  calibration.startSequentialMode(targetLine, 0);
});

document.getElementById('seqPrevBtn').addEventListener('click', () => calibration.stepSequential(-1));
document.getElementById('seqNextBtn').addEventListener('click', () => calibration.stepSequential(1));
document.getElementById('seqStopBtn').addEventListener('click', () => calibration.stopSequentialMode());

document.getElementById('distributeBtn').addEventListener('click', () => {
  if (!calibration.distributeBetweenAnchors()) {
    updateTelemetry('CLICK TWO STATIONS ON THE SAME LINE FIRST TO DISTRIBUTE BETWEEN THEM');
  }
});

// Global Nudge & Scale Buttons
document.querySelectorAll('[data-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const [dx, dy] = btn.dataset.nudge.split(',').map(Number);
    store.transformCoordinates(simulator.currentMap, {
      dx,
      dy,
      lineFilter: calLineSelect.value
    });
    updateTelemetry(`NUDGED ${calLineSelect.value} (${dx}, ${dy})`);
  });
});

document.querySelectorAll('[data-scale]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const [scaleX, scaleY] = btn.dataset.scale.split(',').map(Number);
    store.transformCoordinates(simulator.currentMap, {
      scaleX,
      scaleY,
      lineFilter: calLineSelect.value
    });
    updateTelemetry(`SCALED ${calLineSelect.value} (${scaleX}, ${scaleY})`);
  });
});

// Undo / Redo / Export / Import / Reset
document.getElementById('undoBtn').addEventListener('click', () => {
  if (store.undo(simulator.currentMap)) {
    updateTelemetry('UNDO APPLIED');
  }
});

document.getElementById('redoBtn').addEventListener('click', () => {
  if (store.redo(simulator.currentMap)) {
    updateTelemetry('REDO APPLIED');
  }
});

document.getElementById('exportJsonBtn').addEventListener('click', () => {
  const jsonStr = store.exportMapJson(simulator.currentMap);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${simulator.currentMap}.json`;
  a.click();
  URL.revokeObjectURL(url);
  updateTelemetry(`DOWNLOADED ${simulator.currentMap}.json`);
});

document.getElementById('copyJsonBtn').addEventListener('click', async () => {
  const jsonStr = store.exportMapJson(simulator.currentMap);
  try {
    await navigator.clipboard.writeText(jsonStr);
    updateTelemetry(`COPIED ${simulator.currentMap}.json TO CLIPBOARD`);
  } catch {
    updateTelemetry('CLIPBOARD COPY FAILED - USE SAVE JSON');
  }
});

const jsonUpload = document.getElementById('jsonUpload');
document.getElementById('importJsonBtn').addEventListener('click', () => jsonUpload.click());

function handleJsonFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      store.importMapJson(simulator.currentMap, parsed);
      updateTelemetry(`IMPORTED JSON FOR ${simulator.currentMap.toUpperCase()}`);
    } catch (err) {
      updateTelemetry(`INVALID JSON FILE: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

jsonUpload.addEventListener('change', (e) => handleJsonFile(e.target.files[0]));

document.getElementById('resetMapBtn').addEventListener('click', () => {
  store.resetMap(simulator.currentMap);
  updateTelemetry(`RESET ${simulator.currentMap.toUpperCase()} TO DEFAULT COORDINATES`);
});

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      store.redo(simulator.currentMap);
    } else {
      store.undo(simulator.currentMap);
    }
    updateTelemetry();
    return;
  }

  if (e.key === 'Escape' && calibration.sequentialMode) {
    calibration.stopSequentialMode();
    return;
  }

  // Micro-nudge selected station with arrow keys when in Calibration mode
  if (calibration.enabled && simulator.selectedStation) {
    const step = e.shiftKey ? 0.0025 : 0.0005;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;

    if (dx !== 0 || dy !== 0) {
      e.preventDefault();
      const sel = simulator.selectedStation;
      const stn = store.getLines(simulator.currentMap)[sel.lineKey]?.[sel.stationIdx];
      if (stn) {
        store.pushHistory(simulator.currentMap);
        store.updateStation(
          simulator.currentMap,
          sel.lineKey,
          sel.stationIdx,
          stn.x + dx,
          stn.y + dy,
          calibration.linkInterchanges
        );
        updateTelemetry();
      }
    }
  }
});

// ============================================================================
// MAIN ANIMATION LOOP & BOOT
// ============================================================================
let lastTime = performance.now();

function animate(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  simulator.update(dt);
  simulator.render(now);

  requestAnimationFrame(animate);
}

// Create public/maps folder placeholder info via boot
simulator.setMap('cliff');
tryLoadMapImage('cliff');
updateTelemetry();
requestAnimationFrame(animate);

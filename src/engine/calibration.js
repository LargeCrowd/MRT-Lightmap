import { LINE_STYLES } from '../data/lines.js';

export class CalibrationController {
  constructor(simulator, store, analyzer, onStatusUpdate) {
    this.simulator = simulator;
    this.store = store;
    this.analyzer = analyzer;
    this.onStatusUpdate = onStatusUpdate;

    this.enabled = false;
    this.linkInterchanges = true;
    this.autoSnapOnDrop = false;
    this.snapRadiusPx = 26;

    // Drag state
    this.isDragging = false;
    this.dragTarget = null; // { lineKey, stationIdx, name }

    // Sequential click-to-place state
    this.sequentialMode = false;
    this.seqLineKey = 'EWL';
    this.seqIndex = 0;
    this.lastAnchorIndex = null;

    // Install overlay renderer onto simulator
    this.simulator.calibrationOverlay = (ctx, w, h, scaleFactor) => {
      this._renderOverlay(ctx, w, h, scaleFactor);
    };
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.stopSequentialMode();
      this.isDragging = false;
      this.dragTarget = null;
    }
    this._emitStatus();
  }

  startSequentialMode(lineKey, startIndex = 0) {
    this.enabled = true;
    this.sequentialMode = true;
    this.seqLineKey = lineKey === 'ALL' ? 'EWL' : lineKey;
    this.seqIndex = startIndex;
    this.lastAnchorIndex = null;
    this._selectCurrentSequentialStation();
    this._emitStatus();
  }

  stopSequentialMode() {
    this.sequentialMode = false;
    this.lastAnchorIndex = null;
    this._emitStatus();
  }

  stepSequential(delta) {
    if (!this.sequentialMode) return;
    const stations = this.store.getLines(this.simulator.currentMap)[this.seqLineKey] || [];
    if (stations.length === 0) return;
    this.seqIndex = Math.max(0, Math.min(stations.length - 1, this.seqIndex + delta));
    this._selectCurrentSequentialStation();
    this._emitStatus();
  }

  _selectCurrentSequentialStation() {
    const stations = this.store.getLines(this.simulator.currentMap)[this.seqLineKey] || [];
    const stn = stations[this.seqIndex];
    if (stn) {
      this.simulator.selectedStation = {
        lineKey: this.seqLineKey,
        stationIdx: this.seqIndex,
        name: stn.name,
        x: stn.x,
        y: stn.y
      };
    }
  }

  /**
   * Evenly distributes stations between `lastAnchorIndex` and ` current selected station`
   */
  distributeBetweenAnchors() {
    const sel = this.simulator.selectedStation;
    if (!sel || this.lastAnchorIndex === null || this.lastAnchorIndex === sel.stationIdx) {
      return false;
    }
    const mapId = this.simulator.currentMap;
    const lineKey = sel.lineKey;
    const stations = this.store.getLines(mapId)[lineKey];
    if (!stations) return false;

    const idxA = Math.min(this.lastAnchorIndex, sel.stationIdx);
    const idxB = Math.max(this.lastAnchorIndex, sel.stationIdx);
    if (idxB - idxA < 2) return false;

    const stnA = stations[idxA];
    const stnB = stations[idxB];

    this.store.pushHistory(mapId);
    for (let i = idxA + 1; i < idxB; i++) {
      const f = (i - idxA) / (idxB - idxA);
      const nx = stnA.x + (stnB.x - stnA.x) * f;
      const ny = stnA.y + (stnB.y - stnA.y) * f;
      this.store.updateStation(mapId, lineKey, i, nx, ny, this.linkInterchanges);
    }
    this.simulator.buildNetwork(true);
    this._emitStatus(`Distributed ${idxB - idxA - 1} stations between ${stnA.name} & ${stnB.name}`);
    return true;
  }

  handlePointerDown(normX, normY, event) {
    if (!this.enabled) return false;

    const mapId = this.simulator.currentMap;

    // If in sequential click-to-place mode, place current station at clicked location
    if (this.sequentialMode && event.button === 0) {
      const stations = this.store.getLines(mapId)[this.seqLineKey] || [];
      if (this.seqIndex < stations.length) {
        this.store.pushHistory(mapId);
        let targetX = normX;
        let targetY = normY;

        if ((this.autoSnapOnDrop || event.shiftKey) && this.analyzer.hasPixels()) {
          const snapped = this.analyzer.snapPointToLine(normX, normY, this.seqLineKey, this.snapRadiusPx);
          targetX = snapped.x;
          targetY = snapped.y;
        }

        this.store.updateStation(
          mapId,
          this.seqLineKey,
          this.seqIndex,
          targetX,
          targetY,
          this.linkInterchanges
        );
        this.lastAnchorIndex = this.seqIndex;
        this.simulator.buildNetwork(true);

        if (this.seqIndex < stations.length - 1) {
          this.seqIndex++;
          this._selectCurrentSequentialStation();
        } else {
          this.stopSequentialMode();
        }
        this._emitStatus();
        return true;
      }
    }

    // Standard Calibration mode: check if clicking on a station node to drag
    const hit = this.simulator.findNearestStation(normX, normY, 16);
    if (hit) {
      this.store.pushHistory(mapId);
      this.isDragging = true;
      this.dragTarget = {
        lineKey: hit.lineKey,
        stationIdx: hit.stationIdx,
        name: hit.name
      };
      if (this.simulator.selectedStation?.lineKey === hit.lineKey) {
        this.lastAnchorIndex = this.simulator.selectedStation.stationIdx;
      }
      this.simulator.selectedStation = { ...hit };
      this._emitStatus();
      return true;
    }

    return false;
  }

  handlePointerMove(normX, normY, event) {
    if (!this.enabled || !this.isDragging || !this.dragTarget) return false;

    const mapId = this.simulator.currentMap;
    let targetX = normX;
    let targetY = normY;

    if (event.shiftKey && this.analyzer.hasPixels()) {
      const snapped = this.analyzer.snapPointToLine(normX, normY, this.dragTarget.lineKey, this.snapRadiusPx);
      targetX = snapped.x;
      targetY = snapped.y;
    }

    this.store.updateStation(
      mapId,
      this.dragTarget.lineKey,
      this.dragTarget.stationIdx,
      targetX,
      targetY,
      this.linkInterchanges
    );
    this.simulator.selectedStation = {
      ...this.dragTarget,
      x: targetX,
      y: targetY
    };
    this.simulator.buildNetwork(true);
    this._emitStatus();
    return true;
  }

  handlePointerUp(normX, normY, event) {
    if (!this.enabled || !this.isDragging || !this.dragTarget) return false;

    const mapId = this.simulator.currentMap;
    if ((this.autoSnapOnDrop || event.shiftKey) && this.analyzer.hasPixels()) {
      const snapped = this.analyzer.snapPointToLine(normX, normY, this.dragTarget.lineKey, this.snapRadiusPx);
      this.store.updateStation(
        mapId,
        this.dragTarget.lineKey,
        this.dragTarget.stationIdx,
        snapped.x,
        snapped.y,
        this.linkInterchanges
      );
      this.simulator.selectedStation = {
        ...this.dragTarget,
        x: snapped.x,
        y: snapped.y
      };
      this.simulator.buildNetwork(true);
    }

    this.isDragging = false;
    this.dragTarget = null;
    this._emitStatus();
    return true;
  }

  _renderOverlay(ctx, w, h, scaleFactor) {
    if (!this.enabled) return;

    // Draw subtle edit rings around all editable stations
    for (const stn of this.simulator.stationDirectory) {
      if (this.simulator.soloLine !== 'ALL' && stn.lineKey !== this.simulator.soloLine) continue;
      const px = stn.x * w;
      const py = stn.y * h;
      ctx.beginPath();
      ctx.arc(px, py, 7.5 * scaleFactor, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Highlight selected station
    const sel = this.simulator.selectedStation;
    if (sel) {
      const stations = this.store.getLines(this.simulator.currentMap)[sel.lineKey];
      const liveStn = stations?.[sel.stationIdx];
      if (liveStn) {
        const px = liveStn.x * w;
        const py = liveStn.y * h;
        const color = LINE_STYLES[sel.lineKey]?.color || '#00e5ff';

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 12 * scaleFactor, 0, Math.PI * 2);
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2.5 * scaleFactor;
        ctx.setLineDash([4 * scaleFactor, 3 * scaleFactor]);
        ctx.stroke();

        // Crosshair ticks
        ctx.setLineDash([]);
        ctx.beginPath();
        const cr = 17 * scaleFactor;
        ctx.moveTo(px - cr, py);
        ctx.lineTo(px + cr, py);
        ctx.moveTo(px, py - cr);
        ctx.lineTo(px, py + cr);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * scaleFactor;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _emitStatus(customMessage = null) {
    if (this.onStatusUpdate) {
      this.onStatusUpdate(customMessage);
    }
  }
}

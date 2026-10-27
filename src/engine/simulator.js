import { LINE_STYLES, MAJOR_INTERCHANGES } from '../data/lines.js';

export class MRTSimulator {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;

    this.currentMap = 'cliff';
    this.ledMode = 'intermediate'; // 'intermediate' | 'station' | 'continuous'
    this.labelMode = 'major'; // 'major' | 'all' | 'none'
    this.intermediateCount = 2;
    this.showTrackLines = true;
    this.trainSpeedMultiplier = 1.0;
    this.soloLine = 'ALL'; // 'ALL' or lineKey
    this.imageLoaded = false;

    this.activeNodes = {};
    this.stationDirectory = [];
    this.trainFleet = [];

    // Interaction state
    this.hoveredStation = null;
    this.selectedStation = null; // { lineKey, stationIdx, name, x, y }
    this.calibrationOverlay = null; // Injected by CalibrationController
  }

  setMap(mapId) {
    this.currentMap = mapId;
    this.selectedStation = null;
    this.buildNetwork();
  }

  /**
   * Rebuilds LED node positions from the current map's station coordinates
   * without resetting train positions if only coordinates were tweaked during calibration.
   */
  buildNetwork(preserveTrains = false) {
    const linesData = this.store.getLines(this.currentMap);
    const newActiveNodes = {};
    const newDirectory = [];
    let totalLEDs = 0;

    for (const lineKey of Object.keys(linesData)) {
      const pts = linesData[lineKey];
      if (!pts || pts.length === 0) continue;

      const nodes = [];
      const isLoop = LINE_STYLES[lineKey]?.isLoop;

      for (let i = 0; i < pts.length; i++) {
        const curr = pts[i];
        const stnNode = {
          isStation: true,
          x: curr.x,
          y: curr.y,
          name: curr.name,
          lineKey,
          stationIdx: i
        };
        nodes.push(stnNode);
        newDirectory.push(stnNode);

        const nextIdx = i < pts.length - 1 ? i + 1 : (isLoop ? 0 : -1);
        if (nextIdx !== -1 && this.intermediateCount > 0) {
          const next = pts[nextIdx];
          for (let s = 1; s <= this.intermediateCount; s++) {
            const f = s / (this.intermediateCount + 1);
            nodes.push({
              isStation: false,
              x: curr.x + (next.x - curr.x) * f,
              y: curr.y + (next.y - curr.y) * f,
              lineKey,
              segmentFromIdx: i
            });
          }
        }
      }

      newActiveNodes[lineKey] = nodes;
      totalLEDs += nodes.length;
    }

    this.activeNodes = newActiveNodes;
    this.stationDirectory = newDirectory;

    if (!preserveTrains || this.trainFleet.length === 0) {
      this._spawnTrains();
    } else {
      // Clamp existing train indices in case intermediateCount changed
      for (const t of this.trainFleet) {
        const len = this.activeNodes[t.line]?.length || 0;
        if (len > 0 && t.idx >= len) {
          t.idx = t.idx % len;
        }
      }
    }

    return {
      trains: this.trainFleet.length,
      leds: totalLEDs,
      stations: this.stationDirectory.length
    };
  }

  _spawnTrains() {
    this.trainFleet = [];
    for (const lineKey of Object.keys(this.activeNodes)) {
      const len = this.activeNodes[lineKey].length;
      if (len < 4) continue;
      this.trainFleet.push({ line: lineKey, idx: 2, dir: 1, dwell: 0, speed: 0.045 });
      this.trainFleet.push({ line: lineKey, idx: Math.floor(len * 0.5), dir: -1, dwell: 0, speed: 0.045 });
      if (len > 30) {
        this.trainFleet.push({ line: lineKey, idx: Math.floor(len * 0.8), dir: 1, dwell: 0, speed: 0.045 });
      }
    }
  }

  findNearestStation(normX, normY, maxPixelRadius = 14) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const mx = normX * w;
    const my = normY * h;

    let best = null;
    let bestDist = maxPixelRadius;

    for (const stn of this.stationDirectory) {
      if (this.soloLine !== 'ALL' && stn.lineKey !== this.soloLine) continue;
      const d = Math.hypot(mx - stn.x * w, my - stn.y * h);
      if (d < bestDist) {
        bestDist = d;
        best = stn;
      }
    }
    return best;
  }

  update(dt) {
    const speedMult = this.trainSpeedMultiplier;
    if (speedMult <= 0) return;

    for (const t of this.trainFleet) {
      const nodes = this.activeNodes[t.line];
      if (!nodes || nodes.length === 0) continue;

      if (t.dwell > 0) {
        t.dwell -= dt * speedMult;
        continue;
      }

      const prevIdx = Math.floor(t.idx);
      t.idx += t.dir * t.speed * 22 * dt * speedMult;
      const currIdx = Math.floor(t.idx);

      if (prevIdx !== currIdx && nodes[currIdx] && nodes[currIdx].isStation) {
        t.dwell = 0.85;
      }

      const isLoop = LINE_STYLES[t.line]?.isLoop;
      if (isLoop) {
        if (t.idx >= nodes.length) t.idx = 0;
        if (t.idx < 0) t.idx = nodes.length - 1;
      } else {
        if (t.idx >= nodes.length - 1) {
          t.idx = nodes.length - 1;
          t.dir = -1;
          t.dwell = 1.4;
        }
        if (t.idx <= 0) {
          t.idx = 0;
          t.dir = 1;
          t.dwell = 1.4;
        }
      }
    }
  }

  render(now) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Fallback dark island silhouette if background image isn't loaded yet
    if (!this.imageLoaded) {
      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(24, 34, 48, 0.65)';
      ctx.strokeStyle = 'rgba(70, 95, 130, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(w * 0.49, h * 0.52, w * 0.44, h * 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    const scaleFactor = Math.max(0.75, Math.min(2.2, w / 1360));

    // 1. Draw Track Lines
    if (this.showTrackLines) {
      for (const lineKey of Object.keys(this.activeNodes)) {
        if (this.soloLine !== 'ALL' && lineKey !== this.soloLine) continue;

        const nodes = this.activeNodes[lineKey];
        const meta = LINE_STYLES[lineKey];
        if (!nodes || nodes.length === 0 || !meta) continue;

        ctx.beginPath();
        ctx.moveTo(nodes[0].x * w, nodes[0].y * h);
        for (let i = 1; i < nodes.length; i++) {
          ctx.lineTo(nodes[i].x * w, nodes[i].y * h);
        }
        if (meta.isLoop) ctx.closePath();

        ctx.strokeStyle = meta.color;
        ctx.globalAlpha = this.imageLoaded ? 0.48 : 0.65;
        ctx.lineWidth = (meta.isLRT ? 2.5 : 4.5) * scaleFactor;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }

    // 2. Render Glowing LED Nodes & Blinking Stations
    const pulseWave = 0.5 + 0.5 * Math.sin(now * 0.012);

    for (const lineKey of Object.keys(this.activeNodes)) {
      const isDimmedLine = this.soloLine !== 'ALL' && lineKey !== this.soloLine;
      const nodes = this.activeNodes[lineKey];
      const meta = LINE_STYLES[lineKey];
      if (!nodes || !meta) continue;

      const lineTrains = this.trainFleet.filter(t => t.line === lineKey);

      nodes.forEach((node, i) => {
        if (this.ledMode === 'station' && !node.isStation) return;

        const px = node.x * w;
        const py = node.y * h;

        let intensity = 0.0;
        let isDwellingHere = false;

        if (!isDimmedLine) {
          for (const t of lineTrains) {
            const dist = Math.abs(t.idx - i);
            if (this.ledMode === 'intermediate') {
              if (dist < 1.35) {
                intensity = Math.max(intensity, 1.0 - dist / 1.35);
                if (t.dwell > 0 && dist < 0.8) isDwellingHere = true;
              }
            } else if (this.ledMode === 'station') {
              if (node.isStation && dist < 1.5) {
                intensity = Math.max(intensity, 1.0);
                isDwellingHere = true;
              }
            } else if (this.ledMode === 'continuous') {
              const trail = t.dir > 0 ? t.idx - i : i - t.idx;
              if (trail >= 0 && trail < 4.5) {
                intensity = Math.max(intensity, 1.0 - trail / 4.5);
              }
            }
          }
        }

        const r = (node.isStation ? 4.5 : 2.2) * scaleFactor;
        ctx.globalAlpha = isDimmedLine ? 0.18 : 1.0;

        if (intensity > 0.05) {
          const blinkBoost = isDwellingHere ? 0.6 + 0.8 * pulseWave : 1.0;
          ctx.save();
          ctx.beginPath();
          ctx.arc(px, py, r * (isDwellingHere ? 1.35 : 1.1), 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = meta.color;
          ctx.shadowBlur = 18 * intensity * blinkBoost * scaleFactor;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(px, py, r + 3.5 * scaleFactor, 0, Math.PI * 2);
          ctx.strokeStyle = meta.color;
          ctx.lineWidth = 2.2 * scaleFactor;
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          if (node.isStation) {
            ctx.fillStyle = '#18202c';
            ctx.fill();
            ctx.strokeStyle = meta.color;
            ctx.lineWidth = 1.8 * scaleFactor;
            ctx.stroke();
          } else {
            ctx.fillStyle = 'rgba(255,255,255,0.28)';
            ctx.fill();
          }
        }

        // Labels
        if (node.isStation && this.labelMode !== 'none' && !isDimmedLine) {
          const isMajor = MAJOR_INTERCHANGES.has(node.name);
          const isHovered =
            this.hoveredStation &&
            this.hoveredStation.name === node.name &&
            this.hoveredStation.lineKey === node.lineKey;
          const isSelected =
            this.selectedStation &&
            this.selectedStation.name === node.name &&
            this.selectedStation.lineKey === node.lineKey;

          if (this.labelMode === 'all' || isMajor || isHovered || isSelected) {
            ctx.fillStyle = intensity > 0.2 || isSelected ? '#ffffff' : '#b8c7d6';
            const fontSize = Math.round((isMajor ? 10 : 8.5) * scaleFactor);
            ctx.font = `${isMajor ? 'bold ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(node.name, px, py - 8 * scaleFactor);
          }
        }

        ctx.globalAlpha = 1.0;
      });
    }

    // 3. Render Calibration / Editor Overlay if active
    if (this.calibrationOverlay) {
      this.calibrationOverlay(ctx, w, h, scaleFactor);
    }
  }
}

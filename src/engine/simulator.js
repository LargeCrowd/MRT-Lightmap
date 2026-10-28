import { LINE_STYLES, MAJOR_INTERCHANGES } from '../data/lines.js';

// Target isotropic arc-length spacing per mid-LED density level (1=Low, 2=Med, 3=High)
const DENSITY_TARGET_SPACING = {
  1: 0.0165,
  2: 0.0110,
  3: 0.0078
};

export class MRTSimulator {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;

    this.currentMap = 'cliff';
    this.ledMode = 'intermediate'; // 'intermediate' | 'station' | 'continuous'
    this.labelMode = 'none'; // 'none' by default so canvas text doesn't double-render over map text
    this.intermediateCount = 0; // 0 = Stations-only, 1/2/3 = Low/Med/High uniform spatial density
    this.showTrackLines = false; // Tracks OFF by default
    this.directionFilter = 'ALL'; // 'ALL' | '1' | '-1'
    this.trainSpeedMultiplier = 1.0;
    this.soloLine = 'ALL'; // 'ALL' or lineKey
    this.imageLoaded = false;

    this.activeNodes = {};
    this.trackPolylines = {};
    this.cclDhobyRoute = [];
    this.stationDirectory = [];
    this.stationHubs = []; // Unified station hubs (with concentric rings for multi-line interchanges)
    this.trainFleet = [];

    // Interaction state
    this.hoveredStation = null;
    this.selectedStation = null; // { lineKey, stationIdx, name, x, y }
    this.calibrationOverlay = null; // Injected by CalibrationController
  }

  isLineVisible(lineKey) {
    if (this.soloLine === 'ALL') return true;
    if (lineKey === this.soloLine) return true;
    const parent = LINE_STYLES[lineKey]?.parentLine;
    return parent === this.soloLine;
  }

  setMap(mapId) {
    this.currentMap = mapId;
    this.selectedStation = null;
    this.buildNetwork();
  }

  /**
   * Evaluates a smooth spline through [P0, w25, w50, w75, P1] and returns
   * a dense arc-length lookup table plus helper to sample points at uniform distance.
   */
  _buildSegmentCurve(curr, wps, next, aspect) {
    const ctrlPts = [
      { x: curr.x, y: curr.y },
      { x: wps[0][0], y: wps[0][1] },
      { x: wps[1][0], y: wps[1][1] },
      { x: wps[2][0], y: wps[2][1] },
      { x: next.x, y: next.y }
    ];

    const samples = [{ x: curr.x, y: curr.y, s: 0 }];
    let totalLen = 0;
    const subSteps = 8;

    for (let seg = 0; seg < 4; seg++) {
      const p0 = ctrlPts[Math.max(0, seg - 1)];
      const p1 = ctrlPts[seg];
      const p2 = ctrlPts[seg + 1];
      const p3 = ctrlPts[Math.min(4, seg + 2)];

      for (let step = 1; step <= subSteps; step++) {
        const t = step / subSteps;
        const t2 = t * t;
        const t3 = t2 * t;

        const x =
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
        const y =
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

        const prev = samples[samples.length - 1];
        const ds = Math.hypot(x - prev.x, (y - prev.y) * aspect);
        totalLen += ds;
        samples.push({ x, y, s: totalLen });
      }
    }

    const pointAtArcFraction = frac => {
      const targetS = frac * totalLen;
      if (targetS <= 0) return { x: curr.x, y: curr.y };
      if (targetS >= totalLen) return { x: next.x, y: next.y };
      for (let i = 1; i < samples.length; i++) {
        if (samples[i].s >= targetS) {
          const s0 = samples[i - 1].s;
          const s1 = samples[i].s;
          const u = s1 > s0 ? (targetS - s0) / (s1 - s0) : 0;
          return {
            x: Number((samples[i - 1].x + (samples[i].x - samples[i - 1].x) * u).toFixed(4)),
            y: Number((samples[i - 1].y + (samples[i].y - samples[i - 1].y) * u).toFixed(4))
          };
        }
      }
      return { x: next.x, y: next.y };
    };

    return { totalLen, samples, pointAtArcFraction };
  }

  /**
   * Rebuilds LED node positions, curved track polylines, unified concentric station hubs,
   * and the through-running Circle Line route (Prince Edward Rd <-> Promenade <-> Dhoby Ghaut).
   */
  buildNetwork(preserveTrains = false) {
    const prevTrainFractions = preserveTrains
      ? this.trainFleet.map(t => {
          const arr = t.isCclDhobyRoute ? this.cclDhobyRoute : this.activeNodes[t.line];
          const curNode = arr && arr[Math.max(0, Math.min(arr.length - 1, Math.round(t.idx)))];
          const timeFrac =
            curNode && typeof curNode.timeFrac === 'number'
              ? curNode.timeFrac
              : arr && arr.length > 1
                ? t.idx / (arr.length - 1)
                : 0;
          return { ...t, timeFrac };
        })
      : null;

    const linesData = this.store.getLines(this.currentMap);
    const aspect = (this.canvas.height / this.canvas.width) || 0.708;
    const targetSpacing = DENSITY_TARGET_SPACING[this.intermediateCount] || 0;

    const newActiveNodes = {};
    const newTrackPolylines = {};
    const newDirectory = [];
    const hubsByName = new Map();
    let totalLEDs = 0;

    for (const lineKey of Object.keys(linesData)) {
      const pts = linesData[lineKey];
      if (!pts || pts.length === 0) continue;

      const nodes = [];
      const polyline = [];
      const isLoop = LINE_STYLES[lineKey]?.isLoop;
      const parentLineKey = LINE_STYLES[lineKey]?.parentLine || lineKey;

      for (let i = 0; i < pts.length; i++) {
        const curr = pts[i];
        const nextIdx = i < pts.length - 1 ? i + 1 : (isLoop ? 0 : -1);
        const prevIdx = i > 0 ? i - 1 : (isLoop ? pts.length - 1 : -1);
        const next = nextIdx !== -1 ? pts[nextIdx] : null;
        const prev = prevIdx !== -1 ? pts[prevIdx] : null;

        let wps = null;
        if (next) {
          if (Array.isArray(curr.waypoints) && curr.waypoints.length === 3) {
            wps = curr.waypoints;
          } else {
            wps = [
              [
                Number((curr.x + (next.x - curr.x) * 0.25).toFixed(4)),
                Number((curr.y + (next.y - curr.y) * 0.25).toFixed(4))
              ],
              [
                Number((curr.x + (next.x - curr.x) * 0.5).toFixed(4)),
                Number((curr.y + (next.y - curr.y) * 0.5).toFixed(4))
              ],
              [
                Number((curr.x + (next.x - curr.x) * 0.75).toFixed(4)),
                Number((curr.y + (next.y - curr.y) * 0.75).toFixed(4))
              ]
            ];
          }
        }

        let prevWp = null;
        if (prev) {
          if (Array.isArray(prev.waypoints) && prev.waypoints.length === 3) {
            prevWp = prev.waypoints[2];
          } else {
            prevWp = [
              prev.x + (curr.x - prev.x) * 0.75,
              prev.y + (curr.y - prev.y) * 0.75
            ];
          }
        }

        const stnNode = {
          isStation: true,
          x: curr.x,
          y: curr.y,
          name: curr.name,
          lineKey,
          parentLineKey,
          stationIdx: i,
          nodeIdx: nodes.length,
          fwdTarget: wps ? { x: wps[0][0], y: wps[0][1] } : (prevWp ? { x: prevWp[0], y: prevWp[1] } : null),
          bwdTarget: prevWp ? { x: prevWp[0], y: prevWp[1] } : (wps ? { x: wps[0][0], y: wps[0][1] } : null)
        };
        nodes.push(stnNode);
        if (!(lineKey === 'CCL_EXT' && curr.name === 'Promenade')) {
          newDirectory.push(stnNode);
        }

        // Register station in unified stationHubs so shared interchanges render as concentric rings
        let hub = hubsByName.get(curr.name);
        if (!hub) {
          hub = {
            name: curr.name,
            x: curr.x,
            y: curr.y,
            ringLines: [], // Unique parentLineKeys for concentric rings
            stationNodes: []
          };
          hubsByName.set(curr.name, hub);
        }
        if (!hub.ringLines.includes(parentLineKey)) {
          // Put non-loop / inner lines inside and Circle Line on the outside ring (e.g. Purple inside Yellow at Serangoon)
          if (parentLineKey === 'CCL') {
            hub.ringLines.push(parentLineKey);
          } else {
            const cclIdx = hub.ringLines.indexOf('CCL');
            if (cclIdx !== -1) {
              hub.ringLines.splice(cclIdx, 0, parentLineKey);
            } else {
              hub.ringLines.push(parentLineKey);
            }
          }
        }
        hub.stationNodes.push(stnNode);

        if (next && wps) {
          const curve = this._buildSegmentCurve(curr, wps, next, aspect);
          stnNode.arcLenToNextStation = curve.totalLen;

          for (let k = 0; k < curve.samples.length - 1; k += 2) {
            polyline.push({ x: curve.samples[k].x, y: curve.samples[k].y });
          }

          if (this.intermediateCount > 0 && targetSpacing > 0) {
            const numSubdivisions = Math.max(1, Math.round(curve.totalLen / targetSpacing));
            const numMidLEDs = numSubdivisions - 1;

            for (let s = 1; s <= numMidLEDs; s++) {
              const frac = s / numSubdivisions;
              const pt = curve.pointAtArcFraction(frac);
              nodes.push({
                isStation: false,
                x: pt.x,
                y: pt.y,
                lineKey,
                parentLineKey,
                segmentFromIdx: i,
                nodeIdx: nodes.length
              });
            }
          }
        } else {
          polyline.push({ x: curr.x, y: curr.y });
        }
      }

      // Precompute static tangent angles and exact isotropic distances to adjacent nodes
      for (let i = 0; i < nodes.length; i++) {
        const nextPos = i < nodes.length - 1 ? i + 1 : (isLoop ? 0 : Math.max(0, i - 1));
        const prevPos = i > 0 ? i - 1 : (isLoop ? nodes.length - 1 : Math.min(nodes.length - 1, i + 1));

        if (this.intermediateCount === 0 && nodes[i].isStation) {
          const ft = nodes[i].fwdTarget || nodes[nextPos];
          const bt = nodes[i].bwdTarget || nodes[prevPos];
          nodes[i].angleFwd = Math.atan2(ft.y - nodes[i].y, ft.x - nodes[i].x);
          nodes[i].angleBwd = Math.atan2(bt.y - nodes[i].y, bt.x - nodes[i].x);
        } else {
          nodes[i].angleFwd = Math.atan2(
            nodes[nextPos].y - nodes[i].y,
            nodes[nextPos].x - nodes[i].x
          );
          nodes[i].angleBwd = Math.atan2(
            nodes[prevPos].y - nodes[i].y,
            nodes[prevPos].x - nodes[i].x
          );
        }

        const dNext =
          nodes[i].arcLenToNextStation && this.intermediateCount === 0
            ? nodes[i].arcLenToNextStation
            : Math.hypot(
                nodes[nextPos].x - nodes[i].x,
                (nodes[nextPos].y - nodes[i].y) * aspect
              );
        const dPrev =
          nodes[prevPos].arcLenToNextStation && this.intermediateCount === 0
            ? nodes[prevPos].arcLenToNextStation
            : Math.hypot(
                nodes[i].x - nodes[prevPos].x,
                (nodes[i].y - nodes[prevPos].y) * aspect
              );

        nodes[i].distToNext = Math.max(0.004, dNext);
        nodes[i].distToPrev = Math.max(0.004, dPrev);
      }

      const physSpeedRef = 0.048 * 0.58;
      let cumTime = 0;
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].cumTime = cumTime;
        cumTime += nodes[i].distToNext / physSpeedRef + (nodes[i].isStation ? 0.55 : 0);
      }
      const totalLineTime = Math.max(0.001, cumTime);
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].timeFrac = nodes[i].cumTime / totalLineTime;
      }

      newActiveNodes[lineKey] = nodes;
      newTrackPolylines[lineKey] = polyline;
      totalLEDs += nodes.length;
    }

    this.activeNodes = newActiveNodes;
    this.trackPolylines = newTrackPolylines;
    this.stationDirectory = newDirectory;
    this.stationHubs = Array.from(hubsByName.values());

    // Build through-running Circle Line route:
    // Prince Edward Rd -> (clockwise via HarbourFront, Buona Vista, Bishan, Serangoon, Paya Lebar) -> Promenade -> Esplanade -> Bras Basah -> Dhoby Ghaut
    this.cclDhobyRoute = [];
    const cclNodes = this.activeNodes['CCL'] || [];
    const extNodes = this.activeNodes['CCL_EXT'] || [];
    const peIdx = cclNodes.findIndex(n => n.isStation && n.name === 'Prince Edward Rd');

    if (peIdx !== -1 && extNodes.length > 0) {
      for (let i = peIdx; i >= 0; i--) {
        const n = cclNodes[i];
        this.cclDhobyRoute.push({
          lineKey: 'CCL',
          nodeIdx: i,
          node: n,
          isStation: n.isStation,
          name: n.name,
          x: n.x,
          y: n.y,
          angleFwd: n.angleBwd,
          angleBwd: n.angleFwd,
          distToNext: n.distToPrev,
          distToPrev: n.distToNext
        });
      }
      for (let i = 1; i < extNodes.length; i++) {
        const n = extNodes[i];
        this.cclDhobyRoute.push({
          lineKey: 'CCL_EXT',
          nodeIdx: i,
          node: n,
          isStation: n.isStation,
          name: n.name,
          x: n.x,
          y: n.y,
          angleFwd: n.angleFwd,
          angleBwd: n.angleBwd,
          distToNext: n.distToNext,
          distToPrev: n.distToPrev
        });
      }
      const promRouteIdx = peIdx;
      if (this.cclDhobyRoute[promRouteIdx] && extNodes[0]) {
        this.cclDhobyRoute[promRouteIdx].distToNext = extNodes[0].distToNext;
      }

      const physSpeedRef = 0.048 * 0.58;
      let routeCumTime = 0;
      for (let i = 0; i < this.cclDhobyRoute.length; i++) {
        this.cclDhobyRoute[i].cumTime = routeCumTime;
        routeCumTime +=
          this.cclDhobyRoute[i].distToNext / physSpeedRef +
          (this.cclDhobyRoute[i].isStation ? 0.55 : 0);
      }
      const totalRouteTime = Math.max(0.001, routeCumTime);
      for (let i = 0; i < this.cclDhobyRoute.length; i++) {
        this.cclDhobyRoute[i].timeFrac = this.cclDhobyRoute[i].cumTime / totalRouteTime;
      }
    }

    if (!preserveTrains || !prevTrainFractions || prevTrainFractions.length === 0) {
      this._spawnTrains();
    } else {
      this.trainFleet = prevTrainFractions.map(pt => {
        const arr = pt.isCclDhobyRoute ? this.cclDhobyRoute : this.activeNodes[pt.line];
        return {
          ...pt,
          idx: this._indexAtTimeFrac(arr, pt.timeFrac),
          lastDwelled: -1
        };
      });
    }

    return {
      trains: this.trainFleet.length,
      leds: totalLEDs,
      stations: this.stationHubs.length
    };
  }

  _indexAtTimeFrac(nodes, targetFrac) {
    if (!nodes || nodes.length === 0) return 0;
    const clamped = Math.max(0, Math.min(1, targetFrac));
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const tf = typeof nodes[i].timeFrac === 'number' ? nodes[i].timeFrac : i / Math.max(1, nodes.length - 1);
      const diff = Math.abs(tf - clamped);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  _spawnTrains() {
    this.trainFleet = [];
    for (const lineKey of Object.keys(this.activeNodes)) {
      if (lineKey === 'CCL_EXT') continue;

      const nodes = this.activeNodes[lineKey];
      const len = nodes.length;
      if (len < 2) continue;

      const meta = LINE_STYLES[lineKey];
      const isLRT = meta?.isLRT;
      const isBranch = meta?.isBranch;

      if (lineKey === 'CCL' && this.cclDhobyRoute.length > 4) {
        const rNodes = this.cclDhobyRoute;
        this.trainFleet.push({
          line: 'CCL',
          isCclDhobyRoute: true,
          idx: this._indexAtTimeFrac(rNodes, 0.18),
          dir: 1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: 'CCL',
          isCclDhobyRoute: true,
          idx: this._indexAtTimeFrac(rNodes, 0.68),
          dir: 1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: 'CCL',
          isCclDhobyRoute: true,
          idx: this._indexAtTimeFrac(rNodes, 0.82),
          dir: -1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: 'CCL',
          isCclDhobyRoute: true,
          idx: this._indexAtTimeFrac(rNodes, 0.32),
          dir: -1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: 'CCL',
          isCclDhobyRoute: false,
          idx: Math.floor(len * 0.94),
          dir: 1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        continue;
      }

      if (isBranch) {
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.45),
          dir: 1,
          dwell: 0,
          speed: 0.046,
          lastDwelled: -1
        });
      } else if (isLRT) {
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.25),
          dir: 1,
          dwell: 0,
          speed: 0.036,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.75),
          dir: -1,
          dwell: 0,
          speed: 0.036,
          lastDwelled: -1
        });
      } else {
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.18),
          dir: 1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.68),
          dir: 1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.82),
          dir: -1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
        this.trainFleet.push({
          line: lineKey,
          idx: this._indexAtTimeFrac(nodes, 0.32),
          dir: -1,
          dwell: 0,
          speed: 0.048,
          lastDwelled: -1
        });
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
      if (!this.isLineVisible(stn.lineKey)) continue;
      const d = Math.hypot(mx - stn.x * w, my - stn.y * h);
      if (d < bestDist) {
        bestDist = d;
        best = stn;
      }
    }
    return best;
  }

  getTrainAtStation(stationNode) {
    if (!stationNode) return null;

    for (const t of this.trainFleet) {
      if (this.directionFilter !== 'ALL' && String(t.dir) !== this.directionFilter) continue;

      if (t.isCclDhobyRoute) {
        const rIdx = Math.max(0, Math.min(this.cclDhobyRoute.length - 1, Math.round(t.idx)));
        const entry = this.cclDhobyRoute[rIdx];
        if (entry && entry.isStation && entry.name === stationNode.name) return t;
      } else {
        const nodes = this.activeNodes[t.line];
        if (!nodes) continue;
        const tIdx = Math.round(t.idx) % nodes.length;
        if (nodes[tIdx] && nodes[tIdx].isStation && nodes[tIdx].name === stationNode.name) return t;
      }
    }
    return null;
  }

  update(dt) {
    const speedMult = this.trainSpeedMultiplier;
    if (speedMult <= 0) return;

    for (const t of this.trainFleet) {
      const nodes = t.isCclDhobyRoute ? this.cclDhobyRoute : this.activeNodes[t.line];
      if (!nodes || nodes.length === 0) continue;

      if (t.dwell > 0) {
        t.dwell -= dt * speedMult;
        continue;
      }

      const prevIdx = Math.max(0, Math.min(nodes.length - 1, Math.round(t.idx)));
      const arrayStepDir = (!t.isCclDhobyRoute && t.line === 'CCL') ? -t.dir : t.dir;

      const currNode = nodes[prevIdx];
      const stepDist =
        arrayStepDir > 0
          ? (currNode?.distToNext || 0.015)
          : (currNode?.distToPrev || 0.015);

      const physVelocity = t.speed * 0.58 * speedMult;
      const maxStepPerFrame = 0.95;
      const deltaIdx = Math.min(maxStepPerFrame, (physVelocity * dt) / Math.max(0.004, stepDist));

      t.idx += arrayStepDir * deltaIdx;
      const currIdx = Math.round(t.idx);

      if (
        prevIdx !== currIdx &&
        currIdx !== t.lastDwelled &&
        nodes[currIdx] &&
        nodes[currIdx].isStation
      ) {
        t.lastDwelled = currIdx;
        t.dwell = 0.55;
      }

      const isLoop = !t.isCclDhobyRoute && LINE_STYLES[t.line]?.isLoop;
      if (isLoop) {
        if (t.idx >= nodes.length) {
          t.idx -= nodes.length;
          t.lastDwelled = -1;
        }
        if (t.idx < 0) {
          t.idx += nodes.length;
          t.lastDwelled = -1;
        }
      } else {
        if (t.idx >= nodes.length - 1) {
          t.idx = nodes.length - 1;
          t.dir = -1;
          t.dwell = 1.0;
          t.lastDwelled = nodes.length - 1;
        }
        if (t.idx <= 0) {
          t.idx = 0;
          t.dir = 1;
          t.dwell = 1.0;
          t.lastDwelled = 0;
        }
      }
    }
  }

  render(now) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

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

    const baseScale = Math.max(0.75, Math.min(2.2, w / 1360));
    const scaleFactor = baseScale * (this.currentMap === 'realistic' ? 0.8 : 1.0);

    // 1. Draw Smooth Curved Track Lines (if enabled)
    if (this.showTrackLines) {
      for (const lineKey of Object.keys(this.trackPolylines)) {
        if (!this.isLineVisible(lineKey)) continue;

        const poly = this.trackPolylines[lineKey];
        const meta = LINE_STYLES[lineKey];
        if (!poly || poly.length === 0 || !meta) continue;

        ctx.beginPath();
        ctx.moveTo(poly[0].x * w, poly[0].y * h);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(poly[i].x * w, poly[i].y * h);
        }
        if (meta.isLoop) ctx.closePath();

        ctx.strokeStyle = meta.color;
        ctx.globalAlpha = this.imageLoaded ? 0.45 : 0.65;
        ctx.lineWidth = (meta.isLRT ? 2.5 : 4.5) * scaleFactor;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }

    const pulseWave = 0.5 + 0.5 * Math.sin(now * 0.009);

    // 2. Collect all active trains and map them either to a station hub (by station name)
    //    or to an intermediate mid-LED node (by lineKey & nodeIdx)
    const trainsAtStationHub = new Map(); // stationName -> Array<{ train, parentLineKey, color, angle }>
    const activeMidNodesByLine = new Map(); // lineKey -> Map<nodeIdx, { train, color, angle }>

    for (const t of this.trainFleet) {
      if (this.directionFilter !== 'ALL' && String(t.dir) !== this.directionFilter) continue;

      let lineKey = t.line;
      let nodeIdx = 0;
      let node = null;
      let angle = 0;

      if (t.isCclDhobyRoute) {
        const rIdx = Math.max(0, Math.min(this.cclDhobyRoute.length - 1, Math.round(t.idx)));
        const entry = this.cclDhobyRoute[rIdx];
        if (!entry) continue;
        lineKey = entry.lineKey;
        nodeIdx = entry.nodeIdx;
        node = entry.node;
        angle = t.dir > 0 ? entry.angleFwd : entry.angleBwd;
      } else {
        const nodes = this.activeNodes[lineKey];
        if (!nodes || nodes.length === 0) continue;
        nodeIdx = Math.max(0, Math.min(nodes.length - 1, Math.round(t.idx)));
        node = nodes[nodeIdx];
        if (!node) continue;
        angle = (lineKey === 'CCL')
          ? (t.dir > 0 ? node.angleBwd : node.angleFwd)
          : (t.dir > 0 ? node.angleFwd : node.angleBwd);
      }

      if (!this.isLineVisible(lineKey)) continue;

      const meta = LINE_STYLES[lineKey];
      const parentLineKey = meta?.parentLine || lineKey;
      const color = meta?.color || '#ffffff';

      if (node.isStation) {
        if (!trainsAtStationHub.has(node.name)) {
          trainsAtStationHub.set(node.name, []);
        }
        trainsAtStationHub.get(node.name).push({
          train: t,
          lineKey,
          parentLineKey,
          color,
          angle
        });
      } else {
        if (!activeMidNodesByLine.has(lineKey)) {
          activeMidNodesByLine.set(lineKey, new Map());
        }
        activeMidNodesByLine.get(lineKey).set(nodeIdx, { train: t, color, angle });
      }
    }

    // 3. Draw Unlit Mid-LEDs (Pass 1)
    if (this.ledMode !== 'station') {
      for (const lineKey of Object.keys(this.activeNodes)) {
        const isDimmedLine = !this.isLineVisible(lineKey);
        const nodes = this.activeNodes[lineKey];
        const activeMidMap = activeMidNodesByLine.get(lineKey);
        if (!nodes) continue;

        const rMid = 2.0 * scaleFactor;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.globalAlpha = isDimmedLine ? 0.12 : 0.75;

        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (node.isStation) continue;
          if (activeMidMap && activeMidMap.has(i)) continue;

          ctx.beginPath();
          ctx.arc(node.x * w, node.y * h, rMid, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1.0;
      }
    }

    // 4. Draw Unified Station Hubs with Concentric Colored Rings (Pass 2)
    for (const hub of this.stationHubs) {
      const visibleRingLines = hub.ringLines.filter(lk => this.isLineVisible(lk));
      const isDimmedHub = visibleRingLines.length === 0;
      const ringLinesToDraw = isDimmedHub ? hub.ringLines : visibleRingLines;

      const px = hub.x * w;
      const py = hub.y * h;
      const arriving = trainsAtStationHub.get(hub.name) || [];
      const litParentLines = new Set(arriving.map(a => a.parentLineKey));

      const rCore = 3.9 * scaleFactor;
      const ringStep = 2.4 * scaleFactor;

      ctx.save();
      ctx.globalAlpha = isDimmedHub ? 0.15 : 0.88;

      // Dark background fill covering the outermost concentric ring so rings are crisp
      const outermostR = rCore + (ringLinesToDraw.length - 1) * ringStep;
      ctx.beginPath();
      ctx.arc(px, py, outermostR + 0.8 * scaleFactor, 0, Math.PI * 2);
      ctx.fillStyle = '#101620';
      ctx.fill();

      // Draw each concentric line ring from innermost (k=0) to outermost
      for (let k = 0; k < ringLinesToDraw.length; k++) {
        const lk = ringLinesToDraw[k];
        const lineColor = LINE_STYLES[lk]?.color || '#ffffff';
        const rRing = rCore + k * ringStep;
        const isRingLit = litParentLines.has(lk);

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, rRing, 0, Math.PI * 2);
        ctx.strokeStyle = lineColor;

        if (isRingLit) {
          // Corresponding line ring lights up when a train of that line arrives!
          const activeTrainForLine = arriving.find(a => a.parentLineKey === lk)?.train;
          const isDwelling = activeTrainForLine && activeTrainForLine.dwell > 0;
          const blinkBoost = isDwelling ? 0.55 + 0.75 * pulseWave : 1.0;

          ctx.globalAlpha = 1.0;
          ctx.lineWidth = 2.4 * scaleFactor;
          ctx.shadowColor = lineColor;
          ctx.shadowBlur = 18 * blinkBoost * scaleFactor;
          ctx.stroke();
        } else {
          ctx.lineWidth = 1.65 * scaleFactor;
          ctx.stroke();
        }
        ctx.restore();
      }

      // If at least one train is at this station hub, light up the center LED core
      // and draw each arriving train's directional arrow outside the concentric rings
      if (arriving.length > 0 && !isDimmedHub) {
        const primaryArr = arriving[0];
        const isDwelling = primaryArr.train.dwell > 0;
        const blinkBoost = isDwelling ? 0.55 + 0.75 * pulseWave : 1.0;

        ctx.save();
        ctx.globalAlpha = 1.0;
        ctx.beginPath();
        ctx.arc(px, py, (ringLinesToDraw.length > 1 ? 3.1 : 4.2) * scaleFactor, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = primaryArr.color;
        ctx.shadowBlur = 18 * blinkBoost * scaleFactor;
        ctx.fill();
        ctx.restore();

        for (const arr of arriving) {
          if (typeof arr.angle === 'number' && !Number.isNaN(arr.angle)) {
            ctx.save();
            ctx.globalAlpha = 1.0;
            ctx.translate(px, py);
            ctx.rotate(arr.angle);

            const baseX = outermostR + 3.6 * scaleFactor;
            const tipX = outermostR + 10.0 * scaleFactor;
            const halfW = 4.2 * scaleFactor;

            ctx.beginPath();
            ctx.moveTo(tipX, 0);
            ctx.lineTo(baseX, -halfW);
            ctx.lineTo(baseX, halfW);
            ctx.closePath();

            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = arr.color;
            ctx.lineWidth = 1.2 * scaleFactor;
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      ctx.restore();
    }

    // 5. Draw Lit Mid-LEDs (Pass 3 — trains currently between stations)
    if (this.ledMode !== 'station') {
      for (const [lineKey, activeMidMap] of activeMidNodesByLine.entries()) {
        const nodes = this.activeNodes[lineKey];
        if (!nodes) continue;

        for (const [i, { color, angle }] of activeMidMap.entries()) {
          const node = nodes[i];
          if (!node) continue;

          const px = node.x * w;
          const py = node.y * h;
          const r = 3.2 * scaleFactor;

          ctx.save();

          // Outer colored ring
          ctx.beginPath();
          ctx.arc(px, py, r + 3.0 * scaleFactor, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.2 * scaleFactor;
          ctx.stroke();

          // Glowing LED core
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = color;
          ctx.shadowBlur = 18 * scaleFactor;
          ctx.fill();

          // Single static directional arrow
          if (typeof angle === 'number' && !Number.isNaN(angle)) {
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(angle);

            const tipX = r + 10.5 * scaleFactor;
            const baseX = r + 4.2 * scaleFactor;
            const halfW = 4.2 * scaleFactor;

            ctx.beginPath();
            ctx.moveTo(tipX, 0);
            ctx.lineTo(baseX, -halfW);
            ctx.lineTo(baseX, halfW);
            ctx.closePath();

            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.2 * scaleFactor;
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }

          ctx.restore();
        }
      }
    }

    // 6. Optional Station Labels (drawn once per unified station hub)
    for (const hub of this.stationHubs) {
      const hasVisibleLine = hub.ringLines.some(lk => this.isLineVisible(lk));
      if (!hasVisibleLine) continue;

      const isMajor = MAJOR_INTERCHANGES.has(hub.name);
      const isHovered = this.hoveredStation && this.hoveredStation.name === hub.name;
      const isSelected = this.selectedStation && this.selectedStation.name === hub.name;

      const showLabel =
        isHovered ||
        isSelected ||
        this.labelMode === 'all' ||
        (this.labelMode === 'major' && isMajor);

      if (showLabel) {
        const px = hub.x * w;
        const py = hub.y * h;
        const isLit = trainsAtStationHub.has(hub.name);
        const outermostOffset = (hub.ringLines.length - 1) * 2.4 * scaleFactor;

        ctx.fillStyle = isLit || isSelected || isHovered ? '#ffffff' : '#b8c7d6';
        const fontSize = Math.round((isMajor ? 10 : 8.5) * scaleFactor);
        ctx.font = `${isMajor ? 'bold ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(hub.name, px, py - 10 * scaleFactor - outermostOffset);
      }
    }

    // 7. Render Calibration / Editor Overlay if active
    if (this.calibrationOverlay) {
      this.calibrationOverlay(ctx, w, h, scaleFactor);
    }
  }
}

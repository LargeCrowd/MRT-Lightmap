import { LINE_STYLES } from '../data/lines.js';

export class ImagePixelAnalyzer {
  constructor() {
    this.offscreen = document.createElement('canvas');
    this.ctx = this.offscreen.getContext('2d', { willReadFrequently: true });
    this.imageData = null;
    this.width = 0;
    this.height = 0;
  }

  loadImage(imgElement, targetW = null, targetH = null) {
    if (!imgElement || !imgElement.naturalWidth) {
      this.imageData = null;
      return false;
    }
    this.width = targetW || imgElement.naturalWidth;
    this.height = targetH || imgElement.naturalHeight;
    this.offscreen.width = this.width;
    this.offscreen.height = this.height;
    this.ctx.drawImage(imgElement, 0, 0, this.width, this.height);
    try {
      this.imageData = this.ctx.getImageData(0, 0, this.width, this.height);
      return true;
    } catch (err) {
      console.warn('Could not read image pixels for auto-detect:', err);
      this.imageData = null;
      return false;
    }
  }

  hasPixels() {
    return Boolean(this.imageData && this.width > 0 && this.height > 0);
  }

  _getRgb(px, py) {
    const x = Math.max(0, Math.min(this.width - 1, Math.round(px)));
    const y = Math.max(0, Math.min(this.height - 1, Math.round(py)));
    const idx = (y * this.width + x) * 4;
    const d = this.imageData.data;
    return [d[idx], d[idx + 1], d[idx + 2]];
  }

  /**
   * Returns 0..1 similarity between pixel RGB and line's target RGB palette
   */
  _lineColorMatchScore(rgb, lineKey) {
    const style = LINE_STYLES[lineKey];
    if (!style || !style.targetRgb) return 0;

    const [r, g, b] = rgb;
    // Ignore near-white or near-black background pixels for color matching
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const saturation = maxC - minC;
    if (!style.isLRT && saturation < 28) return 0;

    let bestDist = Infinity;
    for (const [tr, tg, tb] of style.targetRgb) {
      const dist = Math.hypot(r - tr, g - tg, b - tb);
      if (dist < bestDist) bestDist = dist;
    }

    // Max reasonable RGB distance for a match is ~110
    const threshold = style.isLRT ? 65 : 110;
    if (bestDist > threshold) return 0;
    return 1 - bestDist / threshold;
  }

  /**
   * Evaluates how likely pixel (px, py) is a station marker or track centerline
   * for the given MRT line.
   */
  _evaluateCandidate(px, py, lineKey) {
    const centerRgb = this._getRgb(px, py);
    const centerColorScore = this._lineColorMatchScore(centerRgb, lineKey);

    // Check if center is a white/bright station dot core
    const [cr, cg, cb] = centerRgb;
    const isBrightCore = cr > 210 && cg > 210 && cb > 210;

    // Sample a small 8-point ring around (px, py) at radius 4px and 7px
    let ringColorScore = 0;
    let darkBorderScore = 0;
    const radii = [3, 5, 8];
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]
    ];

    let samples = 0;
    for (const rad of radii) {
      for (const [dx, dy] of dirs) {
        const sRgb = this._getRgb(px + dx * rad, py + dy * rad);
        ringColorScore += this._lineColorMatchScore(sRgb, lineKey);
        if (sRgb[0] < 70 && sRgb[1] < 70 && sRgb[2] < 70) {
          darkBorderScore += 1;
        }
        samples++;
      }
    }

    ringColorScore /= samples;
    darkBorderScore /= samples;

    // A station marker often has a bright white core surrounded by line color or dark interchange border,
    // OR is directly on a strong line-colored track pixel.
    let score = centerColorScore * 1.2 + ringColorScore * 1.8;
    if (isBrightCore && (ringColorScore > 0.18 || darkBorderScore > 0.25)) {
      score += 0.95 * (ringColorScore + darkBorderScore * 0.5);
    }

    return score;
  }

  /**
   * Finds the best matching pixel near normalized (nx, ny) for `lineKey`.
   * Returns new normalized { x, y, confidence }
   */
  snapPointToLine(nx, ny, lineKey, searchRadiusPx = 28) {
    if (!this.hasPixels()) {
      return { x: nx, y: ny, confidence: 0 };
    }

    const startPx = nx * this.width;
    const startPy = ny * this.height;
    const step = searchRadiusPx > 30 ? 2 : 1;

    let bestScore = 0.22; // minimum score threshold to move the point
    let bestPx = startPx;
    let bestPy = startPy;

    for (let dy = -searchRadiusPx; dy <= searchRadiusPx; dy += step) {
      for (let dx = -searchRadiusPx; dx <= searchRadiusPx; dx += step) {
        const dist = Math.hypot(dx, dy);
        if (dist > searchRadiusPx) continue;

        const px = startPx + dx;
        const py = startPy + dy;
        if (px < 4 || px >= this.width - 4 || py < 4 || py >= this.height - 4) continue;

        // Slight distance penalty so we prefer the closest matching track/station dot
        const proximityWeight = 1 - (dist / searchRadiusPx) * 0.35;
        const rawScore = this._evaluateCandidate(px, py, lineKey);
        const weightedScore = rawScore * proximityWeight;

        if (weightedScore > bestScore) {
          bestScore = weightedScore;
          bestPx = px;
          bestPy = py;
        }
      }
    }

    return {
      x: bestPx / this.width,
      y: bestPy / this.height,
      confidence: bestScore
    };
  }

  /**
   * Auto-snaps all stations on a line (or all lines) to nearby matching track/station pixels
   */
  snapLineStations(store, mapId, lineKey, searchRadiusPx = 26, linkInterchanges = true) {
    if (!this.hasPixels()) return 0;

    const lines = store.getLines(mapId);
    const targetLines = lineKey === 'ALL' ? Object.keys(lines) : [lineKey];
    store.pushHistory(mapId);

    let snappedCount = 0;
    for (const lKey of targetLines) {
      const stations = lines[lKey];
      if (!stations) continue;
      for (let i = 0; i < stations.length; i++) {
        const stn = stations[i];
        const res = this.snapPointToLine(stn.x, stn.y, lKey, searchRadiusPx);
        if (res.confidence > 0.25) {
          store.updateStation(mapId, lKey, i, res.x, res.y, linkInterchanges);
          snappedCount++;
        }
      }
    }
    return snappedCount;
  }

  /**
   * Automatically estimates the Circle Line (CCL) center and radii by finding
   * orange/yellow CCL pixels across the central region of the image.
   */
  detectCircleLineGeometry() {
    if (!this.hasPixels()) return null;

    const cclPts = [];
    const step = 4;
    for (let y = Math.floor(this.height * 0.2); y < Math.floor(this.height * 0.9); y += step) {
      for (let x = Math.floor(this.width * 0.2); x < Math.floor(this.width * 0.85); x += step) {
        const rgb = this._getRgb(x, y);
        const score = this._lineColorMatchScore(rgb, 'CCL');
        if (score > 0.65) {
          cclPts.push([x / this.width, y / this.height]);
        }
      }
    }

    if (cclPts.length < 30) return null;

    // Compute bounding box & robust median center
    const xs = cclPts.map(p => p[0]).sort((a, b) => a - b);
    const ys = cclPts.map(p => p[1]).sort((a, b) => a - b);
    const minX = xs[Math.floor(xs.length * 0.04)];
    const maxX = xs[Math.floor(xs.length * 0.96)];
    const minY = ys[Math.floor(ys.length * 0.04)];
    const maxY = ys[Math.floor(ys.length * 0.96)];

    const cx = Number(((minX + maxX) / 2).toFixed(4));
    const cy = Number(((minY + maxY) / 2).toFixed(4));
    const rx = Number(((maxX - minX) / 2).toFixed(4));
    const ry = Number(((maxY - minY) / 2).toFixed(4));

    return { cx, cy, rx, ry };
  }
}

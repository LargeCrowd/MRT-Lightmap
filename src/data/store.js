import { cliffDefault, officialDefault, realisticDefault } from './maps/index.js';

const STORAGE_KEY_PREFIX = 'mrt_lightmap_coords_v2_';

const DEFAULTS = {
  cliff: cliffDefault,
  official: officialDefault,
  realistic: realisticDefault
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export class MapDataStore {
  constructor() {
    this.maps = {};
    this.undoStacks = { cliff: [], official: [], realistic: [] };
    this.redoStacks = { cliff: [], official: [], realistic: [] };
    this.listeners = new Set();

    for (const key of Object.keys(DEFAULTS)) {
      this.maps[key] = this._loadMap(key);
    }
  }

  _loadMap(mapId) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PREFIX + mapId);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.lines) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn('Failed to load saved map coordinates from localStorage:', err);
    }
    return deepClone(DEFAULTS[mapId]);
  }

  saveMap(mapId) {
    try {
      localStorage.setItem(STORAGE_KEY_PREFIX + mapId, JSON.stringify(this.maps[mapId]));
    } catch (err) {
      console.warn('Failed to save map coordinates to localStorage:', err);
    }
    this._notify(mapId);
  }

  getMapData(mapId) {
    return this.maps[mapId];
  }

  getLines(mapId) {
    return this.maps[mapId]?.lines || {};
  }

  pushHistory(mapId) {
    const stack = this.undoStacks[mapId];
    stack.push(deepClone(this.maps[mapId]));
    if (stack.length > 40) stack.shift();
    this.redoStacks[mapId] = [];
  }

  undo(mapId) {
    const stack = this.undoStacks[mapId];
    if (!stack || stack.length === 0) return false;
    this.redoStacks[mapId].push(deepClone(this.maps[mapId]));
    this.maps[mapId] = stack.pop();
    this.saveMap(mapId);
    return true;
  }

  redo(mapId) {
    const stack = this.redoStacks[mapId];
    if (!stack || stack.length === 0) return false;
    this.undoStacks[mapId].push(deepClone(this.maps[mapId]));
    this.maps[mapId] = stack.pop();
    this.saveMap(mapId);
    return true;
  }

  resetMap(mapId) {
    this.pushHistory(mapId);
    this.maps[mapId] = deepClone(DEFAULTS[mapId]);
    localStorage.removeItem(STORAGE_KEY_PREFIX + mapId);
    this._notify(mapId);
  }

  updateStation(mapId, lineKey, stationIdx, x, y, linkInterchanges = true) {
    const lines = this.maps[mapId]?.lines;
    if (!lines || !lines[lineKey] || !lines[lineKey][stationIdx]) return;

    const clampedX = Math.max(0.005, Math.min(0.995, Number(x.toFixed(4))));
    const clampedY = Math.max(0.005, Math.min(0.995, Number(y.toFixed(4))));
    const stnName = lines[lineKey][stationIdx].name;

    lines[lineKey][stationIdx].x = clampedX;
    lines[lineKey][stationIdx].y = clampedY;

    // If interchange linking is enabled (or for loop endpoints on the same LRT line),
    // update matching stations with the same name
    if (linkInterchanges) {
      for (const lKey of Object.keys(lines)) {
        for (let i = 0; i < lines[lKey].length; i++) {
          if (lines[lKey][i].name === stnName) {
            lines[lKey][i].x = clampedX;
            lines[lKey][i].y = clampedY;
          }
        }
      }
    }

    this.saveMap(mapId);
  }

  /**
   * Shift and scale all coordinates on a map (or a single line)
   */
  transformCoordinates(mapId, { dx = 0, dy = 0, scaleX = 1, scaleY = 1, lineFilter = 'ALL' }) {
    this.pushHistory(mapId);
    const lines = this.maps[mapId].lines;
    const cx = 0.5;
    const cy = 0.5;

    for (const lKey of Object.keys(lines)) {
      if (lineFilter !== 'ALL' && lKey !== lineFilter) continue;
      for (const stn of lines[lKey]) {
        const nx = cx + (stn.x - cx) * scaleX + dx;
        const ny = cy + (stn.y - cy) * scaleY + dy;
        stn.x = Number(Math.max(0.005, Math.min(0.995, nx)).toFixed(4));
        stn.y = Number(Math.max(0.005, Math.min(0.995, ny)).toFixed(4));
      }
    }
    this.saveMap(mapId);
  }

  /**
   * Project Circle Line stations onto an ellipse defined by (cx, cy, rx, ry)
   */
  fitCircleLineToEllipse(mapId, { cx, cy, rx, ry }, linkInterchanges = true) {
    this.pushHistory(mapId);
    const mapData = this.maps[mapId];
    mapData.circleGeometry = { cx, cy, rx, ry };
    const ccl = mapData.lines.CCL;
    if (!ccl) return;

    for (let i = 0; i < ccl.length; i++) {
      const stn = ccl[i];
      // Preserve current angle relative to center, project to ellipse radius
      const angle = Math.atan2((stn.y - cy) / ry, (stn.x - cx) / rx);
      const nx = cx + rx * Math.cos(angle);
      const ny = cy + ry * Math.sin(angle);
      this.updateStation(mapId, 'CCL', i, nx, ny, linkInterchanges);
    }
    this.saveMap(mapId);
  }

  importMapJson(mapId, jsonObj) {
    if (!jsonObj || !jsonObj.lines) {
      throw new Error('Invalid map JSON: missing "lines" object');
    }
    this.pushHistory(mapId);
    this.maps[mapId] = deepClone(jsonObj);
    this.saveMap(mapId);
  }

  exportMapJson(mapId) {
    return JSON.stringify(this.maps[mapId], null, 2);
  }

  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _notify(mapId) {
    for (const cb of this.listeners) {
      cb(mapId, this.maps[mapId]);
    }
  }
}

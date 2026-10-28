export const MAP_CONFIGS = {
  cliff: {
    id: 'cliff',
    label: '1. Cliff Tan',
    filename: 'Cliff-Tan-MRT-Singapore.jpg',
    candidatePaths: [
      './Cliff-Tan-MRT-Singapore.jpg',
      './maps/Cliff-Tan-MRT-Singapore.jpg'
    ],
    description: 'Circle Line focal layout with proportional station spacing'
  },
  official: {
    id: 'official',
    label: '2. Official LTA',
    filename: 'System Map.svg',
    candidatePaths: [
      './System Map.svg',
      './maps/System Map.svg',
      './System Map.jpg',
      './maps/System Map.jpg'
    ],
    description: 'Official LTA octolinear transit diagram'
  },
  realistic: {
    id: 'realistic',
    label: '3. Geographic',
    filename: 'mrtmap_geographic.v3.svg',
    candidatePaths: [
      './mrtmap_geographic.v3.svg',
      './maps/mrtmap_geographic.v3.svg',
      './mrtmap_geographic.v3.jpg',
      './maps/mrtmap_geographic.v3.jpg'
    ],
    description: 'True geographic track & station alignment across Singapore'
  }
};

export const LINE_STYLES = {
  EWL: {
    code: 'EWL',
    color: '#00c846',
    name: 'East-West Line',
    isLoop: false,
    isLRT: false,
    dirNames: {
      '1': 'Eastbound (➔ Pasir Ris)',
      '-1': 'Westbound (➔ Tuas Link)'
    },
    // Target RGB values used when scanning map image pixels for track colors
    targetRgb: [
      [0, 150, 69],
      [0, 168, 79],
      [0, 200, 70],
      [15, 145, 65]
    ]
  },
  EWL_CG: {
    code: 'EWL_CG',
    parentLine: 'EWL',
    color: '#00c846',
    name: 'East-West Line (Changi Airport Branch)',
    isLoop: false,
    isBranch: true,
    isLRT: false,
    dirNames: {
      '1': 'Eastbound (➔ Changi Airport)',
      '-1': 'Westbound (➔ Tanah Merah)'
    },
    targetRgb: [
      [0, 150, 69],
      [0, 168, 79],
      [0, 200, 70],
      [15, 145, 65]
    ]
  },
  NSL: {
    code: 'NSL',
    color: '#ff331f',
    name: 'North-South Line',
    isLoop: false,
    isLRT: false,
    dirNames: {
      '1': 'Southbound (➔ Marina South Pier)',
      '-1': 'Northbound (➔ Jurong East)'
    },
    targetRgb: [
      [218, 41, 28],
      [230, 35, 30],
      [255, 51, 31],
      [205, 35, 25]
    ]
  },
  NEL: {
    code: 'NEL',
    color: '#b324db',
    name: 'North East Line',
    isLoop: false,
    isLRT: false,
    dirNames: {
      '1': 'Northbound (➔ Punggol Coast)',
      '-1': 'Southbound (➔ HarbourFront)'
    },
    targetRgb: [
      [144, 22, 178],
      [153, 0, 170],
      [179, 36, 219],
      [130, 30, 160]
    ]
  },
  CCL: {
    code: 'CCL',
    color: '#ffaa00',
    name: 'Circle Line',
    isLoop: true,
    isLRT: false,
    dirNames: {
      '1': 'Clockwise (➔ HarbourFront / Bishan / Dhoby Ghaut)',
      '-1': 'Anticlockwise (➔ Bishan / HarbourFront / Prince Edward Rd)'
    },
    targetRgb: [
      [250, 158, 13],
      [255, 170, 0],
      [245, 168, 0],
      [235, 145, 10]
    ]
  },
  CCL_EXT: {
    code: 'CCL_EXT',
    parentLine: 'CCL',
    color: '#ffaa00',
    name: 'Circle Line (Dhoby Ghaut Branch)',
    isLoop: false,
    isBranch: true,
    isLRT: false,
    dirNames: {
      '1': 'Clockwise (Prince Edward Rd ➔ Dhoby Ghaut)',
      '-1': 'Anticlockwise (Dhoby Ghaut ➔ Prince Edward Rd)'
    },
    targetRgb: [
      [250, 158, 13],
      [255, 170, 0],
      [245, 168, 0],
      [235, 145, 10]
    ]
  },
  DTL: {
    code: 'DTL',
    color: '#1a75ff',
    name: 'Downtown Line',
    isLoop: false,
    isLRT: false,
    dirNames: {
      '1': 'Eastbound (➔ Expo / Sungei Bedok)',
      '-1': 'Westbound (➔ Bukit Panjang)'
    },
    targetRgb: [
      [0, 94, 184],
      [26, 117, 255],
      [0, 85, 183],
      [20, 100, 200]
    ]
  },
  TEL: {
    code: 'TEL',
    color: '#b86b2d',
    name: 'Thomson-East Coast Line',
    isLoop: false,
    isLRT: false,
    dirNames: {
      '1': 'Southbound (➔ Bayshore / Sungei Bedok)',
      '-1': 'Northbound (➔ Woodlands North)'
    },
    targetRgb: [
      [157, 91, 37],
      [184, 107, 45],
      [145, 85, 35],
      [165, 100, 48]
    ]
  },
  BPLRT: {
    code: 'BPLRT',
    color: '#8a9ba8',
    name: 'Bukit Panjang LRT',
    isLoop: false,
    isLRT: true,
    dirNames: {
      '1': 'Service A (via Senja / Petir)',
      '-1': 'Service B (via Petir / Senja)'
    },
    targetRgb: [
      [116, 132, 119],
      [138, 155, 168],
      [120, 135, 130]
    ]
  },
  SKLRT: {
    code: 'SKLRT',
    color: '#8a9ba8',
    name: 'Sengkang LRT',
    isLoop: false,
    isLRT: true,
    dirNames: {
      '1': 'East Loop (Compassvale / Rumbia)',
      '-1': 'West Loop (Cheng Lim / Farmway)'
    },
    targetRgb: [
      [116, 132, 119],
      [138, 155, 168],
      [120, 135, 130]
    ]
  },
  PGLRT: {
    code: 'PGLRT',
    color: '#8a9ba8',
    name: 'Punggol LRT',
    isLoop: false,
    isLRT: true,
    dirNames: {
      '1': 'East Loop (Cove / Riviera)',
      '-1': 'West Loop (Sam Kee / Punggol Point)'
    },
    targetRgb: [
      [116, 132, 119],
      [138, 155, 168],
      [120, 135, 130]
    ]
  },
  SX: {
    code: 'SX',
    color: '#d91b81',
    name: 'Sentosa Express',
    isLoop: false,
    isBranch: true,
    isLRT: true,
    dirNames: {
      '1': 'Southbound to Sentosa (➔ Beach)',
      '-1': 'Northbound to Mainland (➔ VivoCity)'
    },
    targetRgb: [
      [175, 25, 130],
      [200, 30, 145],
      [160, 20, 120]
    ]
  }
};

export const MAJOR_INTERCHANGES = new Set([
  'Jurong East',
  'Raffles Place',
  'City Hall',
  'Dhoby Ghaut',
  'Bishan',
  'Paya Lebar',
  'Woodlands',
  'HarbourFront',
  'Serangoon',
  'Marina Bay',
  'Buona Vista',
  'Outram Park',
  'Newton',
  'Orchard',
  'Bugis',
  'Little India',
  'Chinatown',
  'Botanic Gardens',
  'Caldecott',
  'Stevens',
  'MacPherson',
  'Tampines',
  'Promenade',
  'Bayfront',
  'Sengkang',
  'Punggol',
  'Choa Chu Kang',
  'Bukit Panjang'
]);

export const TEXT_PRESETS = [
  {
    id: 'red-plain',
    label: 'Red plain',
    fabricProps: { fill: '#EF4444', stroke: null, strokeWidth: 0, fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 'normal', fontStyle: 'normal', underline: false, textAlign: 'left', padding: 4 }
  },
  {
    id: 'pink-white-border',
    label: 'Pink · White border',
    fabricProps: { fill: '#EC4899', stroke: '#ffffff', strokeWidth: 1, fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 'bold', fontStyle: 'normal', underline: false, textAlign: 'left', padding: 4 }
  },
  {
    id: 'green-black-border',
    label: 'Green · Black border',
    fabricProps: { fill: '#22C55E', stroke: '#000000', strokeWidth: 2, fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 'bold', fontStyle: 'normal', underline: false, textAlign: 'left', padding: 4 }
  },
  {
    id: 'blue-bold',
    label: 'Blue bold · White border',
    fabricProps: { fill: '#3B82F6', stroke: '#ffffff', strokeWidth: 2, fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 'bold', fontStyle: 'italic', underline: false, textAlign: 'left', padding: 4 }
  },
  {
    id: 'white-bold',
    label: 'White bold · Black border',
    fabricProps: { fill: '#ffffff', stroke: null, strokeWidth: 0, fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 'bold', fontStyle: 'normal', underline: false, textAlign: 'left', padding: 4, shadow: { color: 'rgba(0,0,0,0.55)', blur: 8, offsetX: 2, offsetY: 2 } }
  },
  {
    id: 'dark-italic',
    label: 'Dark italic · Light border',
    fabricProps: { fill: '#1E1E2E', stroke: '#9CA3AF', strokeWidth: 2, fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 'normal', fontStyle: 'italic', underline: false, textAlign: 'left', padding: 4, shadow: { color: 'rgba(0,0,0,0.45)', blur: 6, offsetX: 2, offsetY: 2 } }
  }
];

export const RECT_PRESETS = [
  { id: 'red-rounded',  stroke: '#EF4444', strokeWidth: 2, rx: 6, insideFillOpacity: 0, outsideFillOpacity: 0, fillColor: '#EF4444', strokeDashArray: null },
  { id: 'pink-rounded', stroke: '#EC4899', strokeWidth: 5, rx: 6, insideFillOpacity: 0, outsideFillOpacity: 0, fillColor: '#EC4899', strokeDashArray: null },
  { id: 'green-rounded',stroke: '#22C55E', strokeWidth: 5, rx: 6, insideFillOpacity: 0, outsideFillOpacity: 0, fillColor: '#22C55E', strokeDashArray: null },
  { id: 'blue-sharp',   stroke: '#3B82F6', strokeWidth: 5, rx: 0, insideFillOpacity: 0, outsideFillOpacity: 0, fillColor: '#3B82F6', strokeDashArray: null },
  { id: 'white-sharp',  stroke: '#FFFFFF', strokeWidth: 5, rx: 0, insideFillOpacity: 0, outsideFillOpacity: 0, fillColor: '#FFFFFF', strokeDashArray: null },
  { id: 'black-blur',   stroke: '#1a1a2e',  strokeWidth: 10, rx: 22, insideFillOpacity: 0, outsideFillOpacity: 0,    fillColor: '#1a1a2e',  strokeDashArray: null, blurOutside: true  },
];

export const ARROW_PRESETS = [
  // Row 1 — Design arrows with shadow
  { id: 'red-design',   arrowType: 'design',          arrowColor: '#EF4444', arrowWidth: 8, borderColor: null,      borderWidth: 0, shadow: true  },
  { id: 'pink-design',  arrowType: 'design',          arrowColor: '#EC4899', arrowWidth: 8, borderColor: null,      borderWidth: 0, shadow: true  },
  { id: 'green-design', arrowType: 'design',          arrowColor: '#22C55E', arrowWidth: 8, borderColor: null,      borderWidth: 0, shadow: true  },
  // Row 2
  { id: 'blue-design',  arrowType: 'design',          arrowColor: '#3B82F6', arrowWidth: 8, borderColor: null,      borderWidth: 0, shadow: true  },
  { id: 'red-simple',   arrowType: 'simple',          arrowColor: '#EF4444', arrowWidth: 6, borderColor: null,      borderWidth: 0, shadow: false },
  { id: 'red-double',   arrowType: 'double',          arrowColor: '#EF4444', arrowWidth: 6, borderColor: null,      borderWidth: 0, shadow: false },
  // Row 3
  { id: 'gray-line',    arrowType: 'line',            arrowColor: '#9CA3AF', arrowWidth: 6, borderColor: null,      borderWidth: 0, shadow: true  },
  { id: 'red-gradient', arrowType: 'design-gradient', arrowColor: '#EF4444', arrowWidth: 8, borderColor: null,      borderWidth: 0, shadow: true  },
  { id: 'white-dot',    arrowType: 'line-dot',        arrowColor: '#FFFFFF', arrowWidth: 6, borderColor: '#1E1E2E', borderWidth: 2, shadow: true  },
];

export const FREEHAND_PRESETS = [
  { id: 'red',          color: '#EF4444', width: 3, borderColor: null,      borderWidth: 0, shadow: false },
  { id: 'pink-thick',   color: '#EC4899', width: 7, borderColor: null,      borderWidth: 0, shadow: true  },
  { id: 'green-border', color: '#22C55E', width: 3, borderColor: '#000000', borderWidth: 1, shadow: false },
];

export const HIGHLIGHT_PRESETS = [
  { id: 'red',    color: '#EF4444', opacity: 0.30 },
  { id: 'pink',   color: '#EC4899', opacity: 0.30 },
  { id: 'green',  color: '#22C55E', opacity: 0.30 },
  { id: 'blue',   color: '#60A5FA', opacity: 0.30 },
  { id: 'yellow', color: '#FDE047', opacity: 0.30 },
  { id: 'orange', color: '#FB923C', opacity: 0.30 },
];

export const BADGE_PRESETS = [
  { id: 'red-circle',   bg: '#EF4444', fg: '#ffffff', shape: 'circle' },
  { id: 'pink-circle',  bg: '#EC4899', fg: '#ffffff', shape: 'circle' },
  { id: 'green-circle', bg: '#22C55E', fg: '#ffffff', shape: 'circle' },
  { id: 'blue-rect',    bg: '#2563EB', fg: '#ffffff', shape: 'rect'   },
  { id: 'white-rect',   bg: '#FFFFFF', fg: '#1a1a2e', shape: 'rect'   },
  { id: 'dark-rect',    bg: '#1E1E2E', fg: '#ffffff', shape: 'rect'   },
];

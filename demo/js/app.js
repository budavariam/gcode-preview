import { createApp, ref, watch, onMounted, watchEffect } from 'vue';
import { presets as localPresets } from './presets.js';
import * as GCodePreview from 'gcode-preview';
import { defaultSettings } from './default-settings.js';
import { parseIntOrDefault } from './utils.js';

const defaultPreset = 'benchy';
const preferDarkMode = window.matchMedia('(prefers-color-scheme: dark)');
const initialBackgroundColor = preferDarkMode.matches ? '#141414' : '#eee';
const loadProgressive = ref(true);
let observer = null;
let preview = null;
let switchToken = 0;
let presetSwitchTimeout = null;
let renderInProgress = false;

// NEW: Function to parse build volume from G-code comments
const parseBuildVolumeFromGCode = (gcodeText) => {
  const lines = gcodeText.split('\n');
  const bounds = {};

  // Look for bounding box comments
  for (const line of lines) {
    const trimmed = line.trim();

    // Match patterns like "; min_x = 2.361" or ";min_x = 2.361"
    const boundMatch = trimmed.match(/;\s*(min_|max_)([xyz])\s*=\s*([-\d.]+)/i);
    if (boundMatch) {
      const [, minMax, axis, value] = boundMatch;
      const key = `${minMax.toLowerCase()}${axis.toLowerCase()}`;
      bounds[key] = parseFloat(value);
    }
  }

  // Calculate dimensions if we have all required bounds
  if (bounds.min_x !== undefined && bounds.max_x !== undefined &&
    bounds.min_y !== undefined && bounds.max_y !== undefined) {

    const x = Math.abs(bounds.max_x - bounds.min_x);
    const y = Math.abs(bounds.max_y - bounds.min_y);

    // Z dimension (height) - try to get from bounds, otherwise use a default
    let z = 15; // Default height
    if (bounds.min_z !== undefined && bounds.max_z !== undefined) {
      z = Math.abs(bounds.max_z - bounds.min_z);
    }

    // Add some padding to the dimensions (5-10%)
    const padding = 1.05;

    return {
      x: Math.ceil(x * padding),
      y: Math.ceil(y * padding),
      z: Math.ceil(z * padding),
      detected: true,
      bounds: bounds
    };
  }

  return null;
};

// FIXED: Bulletproof color handling
const safeGetHexString = (colorObj, defaultColor = '#95dfa1') => {
  if (!colorObj) return defaultColor;

  // Handle string colors
  if (typeof colorObj === 'string') {
    if (colorObj === '' || colorObj === 'undefined' || colorObj === 'null') {
      return defaultColor;
    }
    return colorObj.startsWith('#') ? colorObj : `#${colorObj}`;
  }

  // Handle Three.js color objects
  if (colorObj && typeof colorObj.getHexString === 'function') {
    try {
      const hex = colorObj.getHexString();
      return hex && hex !== '' ? `#${hex}` : defaultColor;
    } catch {
      return defaultColor;
    }
  }

  return defaultColor;
};

// Simple render without coordination complexity
const simpleRender = async () => {
  if (!preview || renderInProgress) return;

  renderInProgress = true;
  try {
    // Don't skip zero layer files - let the library handle it
    console.log(`[RENDER] Rendering - layers: ${preview.countLayers || 'unknown'}`);
    preview.render();
  } catch (error) {
    console.error('[RENDER] Error:', error);
  } finally {
    renderInProgress = false;
  }
};

// Basic disposal - no complex cleanup
const disposePreview = async () => {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (preview) {
    try {
      preview.dispose();
    } catch (error) {
      console.error('[DISPOSE] Error:', error);
    }
    preview = null;
  }

  document.querySelectorAll('.lil-gui, .stats').forEach(el => el.remove());
  await new Promise(resolve => setTimeout(resolve, 50));
};

// Fresh URL helper
const getFreshUrl = (url) => {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_t=${Date.now()}&_r=${Math.random().toString(36).slice(2)}`;
};

export const app = (window.app = createApp({
  setup() {
    const activeTab = ref('layers');
    const selectedPreset = ref(defaultPreset);
    const thumbnail = ref(null);
    const layerCount = ref(0);
    const fileSize = ref(0);
    const model = ref(null);
    const dragging = ref(false);
    const settings = ref(Object.assign({}, defaultSettings));
    const enableDevMode = ref(false);
    const drawBoundingBox = ref(false);
    const presets = ref(localPresets);
    // NEW: Track detected build volume info
    const detectedBuildVolume = ref(null);

    // Fetch presets from API
    const fetchPresets = async () => {
      try {
        const response = await fetch('http://localhost:2727/preview/gcodes?skip=0&limit=300', { cache: 'no-store' });
        if (!response.ok) return;

        const apiPresets = await response.json();
        const defaultsForDynamic = {
          extrusionWidth: 0.45,
          lineHeight: 0.2,
          extrusionColor: ['#95dfa1'],
          renderExtrusion: true,
          renderTravel: true,
          travelColor: '#00FFFF'
        };

        const newPresets = {};
        apiPresets.forEach(item => {
          newPresets[item.filename] = {
            title: item.filename,
            file: item.url,
            getFileUrl: () => getFreshUrl(item.url),
            model: { name: item.filename },
            ...defaultsForDynamic,
            ...(item.settings || {}),
            buildVolume: { x: 100, y: 100, z: 10 },
            // initialCameraPosition: [-20, 20, 1.8]
          };
        });

        const merged = { ...presets.value };
        let addedCount = 0;
        for (const key in newPresets) {
          if (!(key in localPresets) && !(key in merged)) {
            merged[key] = newPresets[key];
            addedCount++;
          }
        }

        presets.value = merged;
        console.log(`[API] Added ${addedCount} new presets`);
      } catch (error) {
        console.error('[API] Error:', error);
      }
    };

    // Watch preset changes
    watch(selectedPreset, (preset) => {
      if (presetSwitchTimeout) clearTimeout(presetSwitchTimeout);
      presetSwitchTimeout = setTimeout(() => selectPreset(preset), 100);
    });

    const selectTab = (tab) => activeTab.value = tab;
    const addColor = () => settings.value.colors.push('#000000');
    const removeColor = () => settings.value.colors.pop();
    const update = async (evt) => {
      model.value = { name: evt.detail.filename };
      applyDevMode(enableDevMode.value);
      updateUI();
    };

    // FIXED: UI update with build volume detection support
    const updateUI = async () => {
      if (!preview) return;

      try {
        const {
          parser, countLayers, extrusionColor, topLayerColor, lastSegmentColor,
          buildVolume, backgroundColor, singleLayerMode, renderTravel, travelColor,
          renderExtrusion, lineWidth, renderTubes, extrusionWidth, boundingBoxColor
        } = preview;

        if (!parser?.metadata) {
          console.warn('[UI] Parser or metadata missing');
          return;
        }

        // Handle thumbnails
        const { thumbnails } = parser.metadata;
        if (thumbnails && Object.keys(thumbnails).length > 0) {
          const sizes = Object.keys(thumbnails).map(s => parseInt(s.split('x')[0]));
          const largest = Math.max(...sizes);
          const key = Object.keys(thumbnails).find(k => k.startsWith(`${largest}x`));
          thumbnail.value = thumbnails[key]?.src;
        } else {
          thumbnail.value = null;
        }

        layerCount.value = countLayers || 0;

        // FIXED: Safe color processing - handle all edge cases
        const colors = Array.isArray(extrusionColor) ? extrusionColor : [extrusionColor];
        const validColors = colors.map(c => safeGetHexString(c, '#95dfa1'));

        // Ensure we always have at least one valid color
        if (validColors.length === 0 || validColors.every(c => !c || c === '')) {
          validColors.push('#95dfa1');
        }

        // FIXED: Use detected build volume properly
        let finalBuildVolume = buildVolume;
        if (detectedBuildVolume.value) {
          finalBuildVolume = detectedBuildVolume.value;
          // Update the preview's build volume if it exists
          if (preview.buildVolume) {
            Object.assign(preview.buildVolume, detectedBuildVolume.value);
          }
        }

        const currentSettings = {
          startLayer: 1,
          enableStartLayer: false,
          maxLayer: countLayers || 1000,
          endLayer: countLayers || 0,
          enableEndLayer: false,
          singleLayerMode: !!singleLayerMode,
          renderTravel: !!renderTravel,
          travelColor: safeGetHexString(travelColor, '#00FFFF'),
          renderExtrusion: !!renderExtrusion,
          lineWidth: lineWidth || 1,
          renderTubes: !!renderTubes,
          extrusionWidth: extrusionWidth || 0.4,
          colors: validColors,
          topLayerColor: safeGetHexString(topLayerColor, '#FF0000'),
          highlightTopLayer: !!topLayerColor,
          lastSegmentColor: safeGetHexString(lastSegmentColor, '#FFFF00'),
          highlightLastSegment: !!lastSegmentColor,
          buildVolume: finalBuildVolume || { x: 100, y: 100, z: 10 },
          drawBuildVolume: !!finalBuildVolume,
          backgroundColor: safeGetHexString(backgroundColor, initialBackgroundColor),
          boundingBoxColor: safeGetHexString(boundingBoxColor, '#FF00FF')
        };

        Object.assign(settings.value, currentSettings);
        preview.endLayer = countLayers || 0;
        applyDevMode(enableDevMode.value);

        console.log(`[UI] Updated - layers: ${countLayers || 0}, colors: ${validColors.length}, build volume: ${JSON.stringify(finalBuildVolume)}`);
      } catch (error) {
        console.error('[UI] Error:', error);
      }
    };

    // FIXED: G-code loading with proper stream handling
    const loadGCodeFromServer = async (filename) => {
      const currentToken = switchToken;

      try {
        const finalUrl = filename.includes('localhost:2727') ? getFreshUrl(filename) : filename;
        const response = await fetch(finalUrl, { cache: 'no-store' });

        if (currentToken !== switchToken || response.status !== 200) return;

        // NEW: Read the full response text first to parse build volume
        const gcodeText = await response.text();

        // NEW: Try to detect build volume from comments
        const detectedVolume = parseBuildVolumeFromGCode(gcodeText);
        if (detectedVolume) {
          detectedBuildVolume.value = {
            x: detectedVolume.x,
            y: detectedVolume.y,
            z: detectedVolume.z
          };
          console.log(`[BUILD-VOLUME] Detected from G-code: ${detectedVolume.x}x${detectedVolume.y}x${detectedVolume.z}mm`, detectedVolume.bounds);
        } else {
          detectedBuildVolume.value = null;
          console.log('[BUILD-VOLUME] No bounding box comments found in G-code');
        }

        if (currentToken !== switchToken || !preview) return;

        // FIXED: Create proper stream from processed text
        const processedGcode = gcodeText.replace(/^N\d+\s+/gm, "");

        // Create a proper readable stream
        const gcodeStream = new ReadableStream({
          start(controller) {
            // Split into chunks to avoid memory issues with large files
            const chunkSize = 64 * 1024; // 64KB chunks
            for (let i = 0; i < processedGcode.length; i += chunkSize) {
              controller.enqueue(processedGcode.slice(i, i + chunkSize));
            }
            controller.close();
          }
        });

        if (currentToken !== switchToken || !preview) return;

        await preview.processGCode(gcodeStream, { render: false });

        if (currentToken === switchToken) {
          await updateUI();
          setTimeout(() => simpleRender(), 100);
        }
      } catch (error) {
        console.error('[LOAD] Error:', error);
      }
    };

    // FIXED: Simple preset selection - no canvas recreation
    const selectPreset = async (presetName) => {
      const myToken = ++switchToken;

      try {
        const canvas = document.querySelector('canvas.preview');
        if (!canvas) return;

        const preset = presets.value[presetName];
        if (!preset) return;

        model.value = preset.model;
        if (myToken !== switchToken) return;

        // NEW: Reset detected build volume when switching presets
        detectedBuildVolume.value = null;

        await disposePreview();
        if (myToken !== switchToken) return;

        // Initialize with existing canvas - no recreation
        const options = {
          ...defaultSettings,
          ...preset,
          canvas,
          droppable: true,
          backgroundColor: initialBackgroundColor
        };

        window['_preview'] = preview = new GCodePreview.init(options);

        if (myToken !== switchToken) {
          await disposePreview();
          return;
        }

        // Setup observer
        if (observer) observer.disconnect();
        observer = new ResizeObserver(() => {
          if (myToken !== switchToken) return;
          if (preview) {
            preview.resize();
            setTimeout(() => simpleRender(), 50);
          }
        });
        observer.observe(canvas);

        applyDevMode(enableDevMode.value);

        const fileUrl = typeof preset.getFileUrl === 'function' ? preset.file : preset.file;
        if (myToken !== switchToken) return;

        await loadGCodeFromServer(fileUrl);

        if (myToken === switchToken) {
          applyDevMode(enableDevMode.value);
        }
      } catch (error) {
        console.error('[PRESET] Error:', error);
      }
    };

    function applyDevMode(enabled) {
      document.querySelectorAll('.lil-gui, .stats').forEach(el =>
        el.style.display = enabled ? 'block' : 'none'
      );
    }

    watch(enableDevMode, applyDevMode);

    onMounted(async () => {
      try {
        await fetchPresets();
        await selectPreset(defaultPreset);

        // Setup watchers with better error handling
        watchEffect(() => {
          if (!preview) return;
          try {
            preview.backgroundColor = settings.value.backgroundColor;
            if (preview.buildVolume && settings.value.drawBuildVolume) {
              Object.assign(preview.buildVolume, {
                smallGrid: settings.value.buildVolume.smallGrid,
                x: +settings.value.buildVolume.x,
                y: +settings.value.buildVolume.y,
                z: +settings.value.buildVolume.z
              });
            }
            preview.boundingBoxColor = drawBoundingBox.value ?
              (settings.value.boundingBoxColor ?? 'magenta') : undefined;
          } catch (error) {
            console.error('[WATCH-EFFECT] Background/volume error:', error);
          }
        });

        watchEffect(() => {
          if (!preview) return;
          try {
            Object.assign(preview, {
              renderTravel: settings.value.renderTravel,
              travelColor: settings.value.travelColor,
              lineWidth: +settings.value.lineWidth,
              renderExtrusion: settings.value.renderExtrusion,
              renderTubes: settings.value.renderTubes,
              extrusionWidth: +settings.value.extrusionWidth,
              topLayerColor: settings.value.highlightTopLayer ? settings.value.topLayerColor : undefined,
              lastSegmentColor: settings.value.highlightLastSegment ? settings.value.lastSegmentColor : undefined
            });
            setTimeout(() => simpleRender(), 100);
          } catch (error) {
            console.error('[WATCH-EFFECT] Render settings error:', error);
          }
        });

        watchEffect(() => {
          if (!preview) return;
          try {
            const startLayer = parseIntOrDefault(settings.value.startLayer, undefined);
            const endLayer = parseIntOrDefault(settings.value.endLayer, undefined);
            preview.startLayer = settings.value.enableStartLayer ? startLayer : undefined;
            preview.endLayer = settings.value.enableEndLayer ? endLayer : undefined;
          } catch (error) {
            console.error('[WATCH-EFFECT] Layer settings error:', error);
          }
        });

        watchEffect(() => {
          if (!preview) return;
          try {
            preview.singleLayerMode = settings.value.singleLayerMode;
          } catch (error) {
            console.error('[WATCH-EFFECT] Single layer mode error:', error);
          }
        });

        watchEffect(() => {
          if (!preview) return;
          try {
            preview.extrusionColor = settings.value.colors.length === 1 ?
              settings.value.colors[0] : settings.value.colors;
          } catch (error) {
            console.error('[WATCH-EFFECT] Extrusion color error:', error);
          }
        });

      } catch (error) {
        console.error('[MOUNT] Error:', error);
      }
    });

    return {
      presets, activeTab, selectedPreset, thumbnail, layerCount, fileSize,
      model, dragging, settings, loadProgressive, enableDevMode, drawBoundingBox,
      detectedBuildVolume, // NEW: Expose detected build volume
      selectTab, addColor, removeColor, update, resetUI: updateUI,
      loadGCodeFromServer, selectPreset
    };
  }
}).mount('#app'));

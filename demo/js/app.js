import { createApp, ref, watch, onMounted, watchEffect, readonly, computed } from 'vue';
import { presets as localPresets } from './presets.js';
import * as GCodePreview from 'gcode-preview';
import { defaultSettings } from './default-settings.js';
import { parseIntOrDefault } from './utils.js';
import { createPreviewGallery } from './previewGallery.js';

const defaultPreset = 'benchy';
const preferDarkMode = window.matchMedia('(prefers-color-scheme: dark)');
const initialBackgroundColor = preferDarkMode.matches ? '#141414' : '#eee';
const loadProgressive = ref(true);
let observer = null;
let preview = null;
let switchToken = 0;
let presetSwitchTimeout = null;
let renderInProgress = false;

// Function to parse build volume from G-code comments
const parseBuildVolumeFromGCode = (gcodeText) => {
  const lines = gcodeText.split('\n');
  const bounds = {};

  for (const line of lines) {
    const trimmed = line.trim();
    const boundMatch = trimmed.match(/;\s*(min_|max_)([xyz])\s*=\s*([-\d.]+)/i);
    if (boundMatch) {
      const [, minMax, axis, value] = boundMatch;
      const key = `${minMax.toLowerCase()}${axis.toLowerCase()}`;
      bounds[key] = parseFloat(value);
    }
  }

  if (bounds.min_x !== undefined && bounds.max_x !== undefined &&
    bounds.min_y !== undefined && bounds.max_y !== undefined) {

    const x = Math.abs(bounds.max_x - bounds.min_x);
    const y = Math.abs(bounds.max_y - bounds.min_y);
    let z = 15;
    if (bounds.min_z !== undefined && bounds.max_z !== undefined) {
      z = Math.abs(bounds.max_z - bounds.min_z);
    }

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

// Bulletproof color handling
const safeGetHexString = (colorObj, defaultColor = '#95dfa1') => {
  if (!colorObj) return defaultColor;
  if (typeof colorObj === 'string') {
    if (colorObj === '' || colorObj === 'undefined' || colorObj === 'null') {
      return defaultColor;
    }
    return colorObj.startsWith('#') ? colorObj : `#${colorObj}`;
  }
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

// URL Query Parameter Management
const getQueryParam = (key) => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(key);
};

const setQueryParam = (key, value) => {
  const url = new URL(window.location);
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, '', url);
};

export const app = (window.app = createApp({
  components: {
    PreviewGallery: createPreviewGallery()
  },
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
    const detectedBuildVolume = ref(null);

    // Gallery state
    const showGallery = ref(false);

    // Selected item state for URL sync
    const selectedItem = ref(null);

    // **CRITICAL**: Flag to prevent default preset selection
    const hasInitialized = ref(false);

    // Add pagination state
    const currentSkip = ref(0);
    const itemsPerLoad = ref(100);
    const isLoading = ref(false);
    const hasMorePresets = ref(true);

    // Dynamic presets: filter only non-static ones
    const dynamicPresets = computed(() => {
      const result = {};
      for (const [k, p] of Object.entries(presets.value)) {
        if (!(k in localPresets)) {
          result[k] = {
            ...p,
            initialCameraPosition: [50, 50, 150]
          };
        }
      }
      return result;
    });

    // **NEW**: Gallery URL Parameter Management
    const getGalleryQueryParam = () => {
      return getQueryParam('gallery') === 'true';
    };

    const setGalleryQueryParam = (show) => {
      if (show) {
        setQueryParam('gallery', 'true');
      } else {
        setQueryParam('gallery', null);
      }
    };

    // **NEW**: Initialize gallery state from URL
    const initializeGalleryFromUrl = () => {
      const shouldShowGallery = getGalleryQueryParam();
      if (shouldShowGallery !== showGallery.value) {
        console.log(`[APP] Setting gallery visibility from URL: ${shouldShowGallery}`);
        showGallery.value = shouldShowGallery;
      }
    };

    // **NEW**: Watch gallery state and update URL
    watch(showGallery, (newValue) => {
      if (hasInitialized.value) {
        console.log(`[APP] Gallery state changed: ${newValue}, updating URL`);
        setGalleryQueryParam(newValue);
      }
    });

    // **FIXED**: Load selected item from URL with proper timing
    const loadSelectedItemFromUrl = () => {
      const selectedParam = getQueryParam('selectedItem');
      if (selectedParam && presets.value[selectedParam]) {
        console.log(`[APP] Loading selected item from URL: ${selectedParam}`);
        selectedItem.value = selectedParam;
        selectedPreset.value = selectedParam;
        return true;
      } else if (selectedParam) {
        console.warn(`[APP] Selected item ${selectedParam} not found in presets, will try to load more`);
        // Don't clear URL param immediately - we'll try to find it
        return selectedParam;
      }
      return false;
    };

    // **NEW**: Enhanced loadMorePresets to handle specific item search
    const loadMorePresetsUntilFound = async (targetItem, maxAttempts = 5) => {
      let attempts = 0;

      while (attempts < maxAttempts && !presets.value[targetItem] && hasMorePresets.value) {
        attempts++;
        console.log(`[APP] Loading more presets (attempt ${attempts}) to find: ${targetItem}`);
        await loadMorePresets();
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return presets.value[targetItem] !== undefined;
    };

    // **FIXED**: Enhanced initializeSelection to handle missing items
    const initializeSelection = async () => {
      // Wait for presets to be loaded
      if (Object.keys(presets.value).length <= Object.keys(localPresets).length) {
        console.log('[APP] Waiting for presets to load...');
        await new Promise((resolve) => {
          const stopWatching = watch(presets, (newPresets) => {
            if (Object.keys(newPresets).length > Object.keys(localPresets).length) {
              console.log('[APP] Presets loaded, proceeding with selection');
              stopWatching();
              resolve();
            }
          });
        });
      }

      // **NEW**: Check URL parameter and handle missing items
      const selectedParam = getQueryParam('selectedItem');
      if (selectedParam) {
        if (presets.value[selectedParam]) {
          // Item exists in loaded presets
          console.log(`[APP] ✅ Found URL selection in loaded presets: ${selectedParam}`);
          selectedItem.value = selectedParam;
          selectedPreset.value = selectedParam;
          hasInitialized.value = true;
          return selectedParam;
        } else {
          // **NEW**: Item not in current presets - try to load more or wait
          console.log(`[APP] ⚠️ URL selection '${selectedParam}' not found in current presets, attempting to load more...`);

          // Try loading more presets to find the item
          const found = await loadMorePresetsUntilFound(selectedParam, 3);

          // Check again after loading attempts
          if (found && presets.value[selectedParam]) {
            console.log(`[APP] ✅ Found URL selection after loading more presets: ${selectedParam}`);
            selectedItem.value = selectedParam;
            selectedPreset.value = selectedParam;
            hasInitialized.value = true;
            return selectedParam;
          } else {
            // **NEW**: Still not found - preserve URL param but load default for now
            console.warn(`[APP] ⚠️ URL selection '${selectedParam}' not found after loading attempts`);
            console.log(`[APP] Preserving URL parameter but loading default preset for now`);
            // Don't clear the URL parameter - keep it for potential future loads
            selectedItem.value = selectedParam; // Keep URL selection in state
            selectedPreset.value = defaultPreset; // But load default for display
            hasInitialized.value = true;
            return defaultPreset;
          }
        }
      } else {
        // No URL parameter - use default
        console.log(`[APP] No URL selection found, using default: ${defaultPreset}`);
        selectedItem.value = defaultPreset;
        selectedPreset.value = defaultPreset;
        hasInitialized.value = true;
        return defaultPreset;
      }
    };

    // Watch selectedItem and update URL
    watch(selectedItem, (newItem) => {
      if (newItem && hasInitialized.value) {
        console.log(`[APP] Updating URL with selected item: ${newItem}`);
        setQueryParam('selectedItem', newItem);
      }
    });

    // Enhanced fetchPresets with pagination support
    const fetchPresets = async (loadMore = false) => {
      if (isLoading.value) return;

      isLoading.value = true;

      try {
        const skip = loadMore ? currentSkip.value : 0;
        const limit = itemsPerLoad.value;

        console.log(`[API] Fetching presets: skip=${skip}, limit=${limit}`);

        const response = await fetch(
          `http://localhost:2727/preview/gcodes?skip=${skip}&limit=${limit}`,
          { cache: 'no-store' }
        );

        if (!response.ok) {
          console.error(`[API] Request failed: ${response.status} ${response.statusText}`);
          return;
        }

        const apiPresets = await response.json();
        console.log(`[API] Received ${apiPresets.length} presets`);

        hasMorePresets.value = apiPresets.length === limit;

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
            initialCameraPosition: [50, 50, 150],
          };
        });

        if (loadMore) {
          const merged = { ...presets.value };
          let addedCount = 0;

          for (const key in newPresets) {
            if (!(key in merged)) {
              merged[key] = newPresets[key];
              addedCount++;
            }
          }

          presets.value = merged;
          currentSkip.value += limit;
          console.log(`[API] Added ${addedCount} new presets (total skip: ${currentSkip.value})`);
        } else {
          const merged = { ...presets.value };
          let addedCount = 0;

          for (const key in newPresets) {
            if (!(key in localPresets) && !(key in merged)) {
              merged[key] = newPresets[key];
              addedCount++;
            }
          }

          presets.value = merged;
          currentSkip.value = limit;
          console.log(`[API] Initial load: ${addedCount} new presets`);
        }

      } catch (error) {
        console.error('[API] Error fetching presets:', error);
        hasMorePresets.value = false;
      } finally {
        isLoading.value = false;
      }
    };

    // Load more presets function
    const loadMorePresets = async () => {
      if (!hasMorePresets.value || isLoading.value) {
        console.log('[API] No more presets to load or already loading');
        return;
      }
      await fetchPresets(true);
    };

    // Reset presets function
    const resetPresets = async () => {
      currentSkip.value = 0;
      hasMorePresets.value = true;
      presets.value = { ...localPresets };
      await fetchPresets(false);
    };

    // **NEW**: Open gallery function with URL sync
    const openGallery = () => {
      console.log('[APP] Opening gallery');
      showGallery.value = true;
    };

    // **NEW**: Close gallery function with URL sync
    const closeGallery = () => {
      console.log('[APP] Closing gallery');
      showGallery.value = false;
    };

    // **UPDATED**: Enhanced selectPresetFromGallery to handle missing items
    const selectPresetFromGallery = async (presetName) => {
      console.log(`[APP] Gallery selected preset: ${presetName}`);

      // Check if preset exists, if not try to load it
      if (!presets.value[presetName]) {
        console.log(`[APP] Preset '${presetName}' not in current list, trying to load more...`);
        const found = await loadMorePresetsUntilFound(presetName);

        if (!found) {
          console.error(`[APP] Could not find preset '${presetName}' after loading more presets`);
          return; // Don't proceed if we can't find the preset
        }
      }

      selectedItem.value = presetName;
      selectPreset(presetName);
    };

    // **FIXED**: Only watch preset changes after initialization
    watch(selectedPreset, (preset) => {
      if (!hasInitialized.value) {
        console.log('[APP] Skipping preset change before initialization');
        return;
      }

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

    // UI update with build volume detection support
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

        // Safe color processing
        const colors = Array.isArray(extrusionColor) ? extrusionColor : [extrusionColor];
        const validColors = colors.map(c => safeGetHexString(c, '#95dfa1'));

        if (validColors.length === 0 || validColors.every(c => !c || c === '')) {
          validColors.push('#95dfa1');
        }

        // Use detected build volume properly
        let finalBuildVolume = buildVolume;
        if (detectedBuildVolume.value) {
          finalBuildVolume = detectedBuildVolume.value;
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

    // G-code loading with stream-based build volume detection
    const loadGCodeFromServer = async (filename) => {
      const currentToken = switchToken;

      try {
        const finalUrl = filename.includes('localhost:2727') ? getFreshUrl(filename) : filename;
        const response = await fetch(finalUrl, { cache: 'no-store' });

        if (currentToken !== switchToken || response.status !== 200) return;
        if (currentToken !== switchToken || !preview) return;

        const bounds = {};
        let boundingBoxDetected = false;

        const gcodeStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TransformStream({
            transform(chunk, controller) {
              let processedChunk = chunk.replace(/^N\d+\s+/gm, "");

              const lines = processedChunk.split('\n');
              for (const line of lines) {
                const trimmed = line.trim();
                const boundMatch = trimmed.match(/;\s*(min_|max_)([xyz])\s*=\s*([-\d.]+)/i);
                if (boundMatch) {
                  const [, minMax, axis, value] = boundMatch;
                  const key = `${minMax.toLowerCase()}${axis.toLowerCase()}`;
                  bounds[key] = parseFloat(value);

                  if (!boundingBoxDetected &&
                    bounds.min_x !== undefined && bounds.max_x !== undefined &&
                    bounds.min_y !== undefined && bounds.max_y !== undefined) {

                    const x = Math.abs(bounds.max_x - bounds.min_x);
                    const y = Math.abs(bounds.max_y - bounds.min_y);
                    let z = 15;
                    if (bounds.min_z !== undefined && bounds.max_z !== undefined) {
                      z = Math.abs(bounds.max_z - bounds.min_z);
                    }

                    const padding = 1.05;
                    detectedBuildVolume.value = {
                      x: Math.ceil(x * padding),
                      y: Math.ceil(y * padding),
                      z: Math.ceil(z * padding)
                    };

                    boundingBoxDetected = true;
                    console.log(`[BUILD-VOLUME] Detected in stream: ${detectedBuildVolume.value.x}x${detectedBuildVolume.value.y}x${detectedBuildVolume.value.z}mm`, bounds);
                  }
                }
              }

              controller.enqueue(processedChunk);
            }
          }));

        if (currentToken !== switchToken || !preview) return;

        await preview.processGCode(gcodeStream, { render: false });

        if (currentToken === switchToken) {
          if (!boundingBoxDetected) {
            detectedBuildVolume.value = null;
            console.log('[BUILD-VOLUME] No bounding box comments found in G-code stream');
          }

          await updateUI();
          setTimeout(() => simpleRender(), 100);
        }
      } catch (error) {
        console.error('[LOAD] Error:', error);
      }
    };

    // Simple preset selection with URL sync
    const selectPreset = async (presetName) => {
      const myToken = ++switchToken;

      try {
        const canvas = document.querySelector('canvas.preview');
        if (!canvas) return;

        const preset = presets.value[presetName];
        if (!preset) return;

        // Update selected item state for URL sync (only if initialized)
        if (hasInitialized.value) {
          selectedItem.value = presetName;
        }

        model.value = preset.model;
        if (myToken !== switchToken) return;

        detectedBuildVolume.value = null;

        await disposePreview();
        if (myToken !== switchToken) return;

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
        console.log('[APP] 🚀 Starting app initialization...');

        // **NEW**: Initialize gallery state from URL first
        initializeGalleryFromUrl();

        // 1. Fetch presets first
        await fetchPresets();
        console.log('[APP] ✅ Presets loaded');

        // 2. Initialize selection (URL takes precedence over default)
        const selectedPresetName = await initializeSelection();
        console.log(`[APP] ✅ Selection initialized: ${selectedPresetName}`);

        // 3. Load the selected preset
        await selectPreset(selectedPresetName);
        console.log(`[APP] ✅ Preset loaded: ${selectedPresetName}`);

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
      // Original returns
      presets, activeTab, selectedPreset, thumbnail, layerCount, fileSize,
      model, dragging, settings, loadProgressive, enableDevMode, drawBoundingBox,
      detectedBuildVolume,
      selectTab, addColor, removeColor, update, resetUI: updateUI,
      loadGCodeFromServer, selectPreset,

      // Add pagination-related returns
      loadMorePresets,
      resetPresets,
      isLoading,
      hasMorePresets,
      currentSkip: readonly(currentSkip),

      // **UPDATED**: Gallery functionality with new methods
      showGallery,
      dynamicPresets,
      selectPresetFromGallery,
      openGallery,   // **NEW**
      closeGallery,  // **NEW**

      // URL sync functionality
      selectedItem: readonly(selectedItem),
    };
  }
}).mount('#app'));

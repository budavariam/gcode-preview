import { createApp, ref, watch, onMounted, watchEffect } from 'vue';
import { presets as localPresets } from './presets.js';
import * as GCodePreview from 'gcode-preview';
import { defaultSettings } from './default-settings.js';
import { parseIntOrDefault } from './utils.js';

const defaultPreset = 'benchy'; // default preset to load
const preferDarkMode = window.matchMedia('(prefers-color-scheme: dark)');
const initialBackgroundColor = preferDarkMode.matches ? '#141414' : '#eee';
const statsContainer = () => document.querySelector('.sidebar');
const loadProgressive = ref(true);
let observer = null;
let preview = null;

// Enhanced race protection — serialize preset switching
let switchToken = 0;
let presetSwitchTimeout = null;

// Helper function to safely get hex color string
const safeGetHexString = (colorObj, defaultColor = '#000000') => {
  try {
    if (!colorObj || typeof colorObj.getHexString !== 'function') {
      console.warn('[COLOR] Invalid color object, using default:', defaultColor);
      return defaultColor;
    }
    const hex = colorObj.getHexString();
    return hex ? `#${hex}` : defaultColor;
  } catch (error) {
    console.warn('[COLOR] Error getting hex string, using default:', error, defaultColor);
    return defaultColor;
  }
};

// Centralized and robustly dispose preview + observers + UI with async cleanup
const disposePreview = async () => {
  console.log('[DISPOSE] Starting preview disposal');
  try {
    if (observer) {
      console.log('[DISPOSE] Disconnecting observer');
      observer.disconnect();
      observer = null;
      console.log('[DISPOSE] Observer disconnected successfully');
    }
  } catch (e) {
    console.error('[DISPOSE] Observer disconnect failed:', e);
  }

  if (preview) {
    try {
      console.log('[DISPOSE] Disposing preview object');
      preview.dispose();
      console.log('[DISPOSE] Preview disposed successfully');
    } catch (e) {
      console.error('[DISPOSE] Preview dispose failed:', e);
    }
    preview = null;
  }

  console.log('[DISPOSE] Removing GUI elements');
  const guiElements = document.querySelectorAll('.lil-gui, .stats');
  console.log(`[DISPOSE] Found ${guiElements.length} GUI elements to remove`);
  guiElements.forEach((el) => el.remove());

  // Give the cleanup time to complete
  console.log('[DISPOSE] Waiting for cleanup to complete');
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log('[DISPOSE] Disposal complete');
};

// Helper: unique URL each time for dynamic presets (avoid stale/expired responses)
const getFreshUrl = (url) => {
  console.log(`[URL] Generating fresh URL for: ${url}`);
  try {
    const u = new URL(url, window.location.href);
    u.searchParams.set('_t', Date.now().toString());
    u.searchParams.set('_n', Math.random().toString(36).slice(2));
    const freshUrl = u.toString();
    console.log(`[URL] Fresh URL generated: ${freshUrl}`);
    return freshUrl;
  } catch (e) {
    console.log(`[URL] URL constructor failed, using string manipulation: ${e.message}`);
    const sep = url.includes('?') ? '&' : '?';
    const freshUrl = `${url}${sep}_t=${Date.now()}&_n=${Math.random().toString(36).slice(2)}`;
    console.log(`[URL] Fresh URL generated via string: ${freshUrl}`);
    return freshUrl;
  }
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

    // Fetch presets from API and merge with local presets
    const fetchPresets = async () => {
      console.log('[API] Fetching presets from API');
      try {
        const response = await fetch('http://localhost:2727/preview/gcodes?skip=0&limit=300', { cache: 'no-store' });
        console.log(`[API] Response status: ${response.status}`);

        if (!response.ok) {
          console.warn(`[API] Failed to fetch presets from API: ${response.status} ${response.statusText}`);
          return;
        }

        const apiPresets = await response.json();
        console.log(`[API] Received ${apiPresets.length} presets from API`);

        // Dynamic presets defaults to match originals (important for stable rendering)
        const defaultsForDynamic = {
          extrusionWidth: 0.45,
          lineHeight: 0.2,
          extrusionColor: ['#95dfa1'],
          renderExtrusion: true,
          renderTravel: true,
          travelColor: '#00FFFF'
        };

        // Convert API response to presets format with defaults
        const newPresets = {};
        apiPresets.forEach((item, index) => {
          console.log(`[API] Processing preset ${index + 1}/${apiPresets.length}: ${item.filename}`);
          const sourceUrl = item.url;
          newPresets[item.filename] = {
            title: item.filename,
            file: sourceUrl,
            getFileUrl: () => getFreshUrl(sourceUrl), // used when loading
            model: {
              name: item.filename
            },
            ...defaultsForDynamic,
            ...(item.settings || {}),
            buildVolume: {
              x: 300,
              y: 180,
              z: 0
            },
            initialCameraPosition: [-20, 20, 1.8]
          };
        });

        // Merge: local presets take priority, then add new from API if missing (reactivity-safe)
        const merged = { ...presets.value };
        let addedCount = 0;
        for (const key in newPresets) {
          if (!(key in localPresets) && !(key in merged)) {
            merged[key] = newPresets[key];
            addedCount++;
          }
        }

        console.log(`[API] Added ${addedCount} new presets from API`);
        console.log(`[API] Total presets after merge: ${Object.keys(merged).length}`);
        presets.value = merged;
      } catch (error) {
        console.error('[API] Error fetching presets from API:', error);
      }
    };

    // Debounced preset selection
    watch(selectedPreset, (preset) => {
      console.log(`[WATCH] Preset selection changed to: ${preset}`);
      if (presetSwitchTimeout) {
        console.log('[WATCH] Clearing previous preset switch timeout');
        clearTimeout(presetSwitchTimeout);
      }
      presetSwitchTimeout = setTimeout(() => {
        console.log(`[WATCH] Executing delayed preset selection: ${preset}`);
        selectPreset(preset);
      }, 100); // 100ms debounce
    });

    const selectTab = (tab) => {
      console.log(`[UI] Tab selected: ${tab}`);
      activeTab.value = tab;
    };

    const addColor = () => {
      console.log('[UI] Adding color');
      settings.value.colors.push('#000000');
    };

    const removeColor = () => {
      console.log('[UI] Removing color');
      settings.value.colors.pop();
    };

    const update = async (evt) => {
      console.log(`[UPDATE] Update called for: ${evt.detail.filename}`);
      model.value = {
        name: evt.detail.filename
      };
      applyDevMode(enableDevMode.value);
      updateUI();
    };

    // Update UI with current preview settings
    const updateUI = async () => {
      console.log('[UI] Updating UI with current preview settings');
      try {
        if (!preview) {
          console.error('[UI] Preview is null, cannot update UI');
          return;
        }

        const {
          parser,
          countLayers,
          extrusionColor,
          topLayerColor,
          lastSegmentColor,
          buildVolume,
          backgroundColor,
          singleLayerMode,
          renderTravel,
          travelColor,
          renderExtrusion,
          lineWidth,
          renderTubes,
          extrusionWidth,
          boundingBoxColor
        } = preview;

        console.log(`[UI] Preview data - layers: ${countLayers}, parser exists: ${!!parser}`);

        if (!parser || !parser.metadata) {
          console.error('[UI] Parser or metadata is missing');
          return;
        }

        // Check for zero layers and warn
        if (countLayers === 0) {
          console.warn('[UI] G-code has zero layers - this may be invalid G-code or processing issue');
        }

        const { thumbnails } = parser.metadata;
        console.log(`[UI] Thumbnails available: ${Object.keys(thumbnails || {}).length}`);

        // get largest thumbnail available
        if (thumbnails && Object.keys(thumbnails).length > 0) {
          const thumbnailSizes = Object.keys(thumbnails).map((size) => parseInt(size.split('x')[0]));
          const largestThumbnailSize = Math.max(...thumbnailSizes);
          const largestThumbnailKey = Object.keys(thumbnails).find((key) => key.startsWith(`${largestThumbnailSize}x`));
          thumbnail.value = thumbnails[largestThumbnailKey]?.src;
          console.log(`[UI] Thumbnail set: ${largestThumbnailKey}`);
        } else {
          console.log('[UI] No thumbnails available');
          thumbnail.value = null;
        }

        layerCount.value = countLayers;
        console.log(`[UI] Layer count set to: ${countLayers}`);

        // Safe color processing with fallbacks
        const colors = extrusionColor instanceof Array ? extrusionColor : [extrusionColor];
        console.log(`[UI] Processing ${colors.length} extrusion colors`);

        // Use safe color extraction with fallbacks
        const safeColors = colors.map((c, index) => {
          const safeColor = safeGetHexString(c, `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`);
          console.log(`[UI] Color ${index}: ${safeColor}`);
          return safeColor;
        });

        const currentSettings = {
          startLayer: 1,
          enableStartLayer: false,
          maxLayer: countLayers || 1000,
          endLayer: countLayers,
          enableEndLayer: false,
          singleLayerMode,
          renderTravel,
          travelColor: safeGetHexString(travelColor, '#00FFFF'),
          renderExtrusion,
          lineWidth,
          renderTubes,
          extrusionWidth,
          colors: safeColors,
          topLayerColor: safeGetHexString(topLayerColor, '#FF0000'),
          highlightTopLayer: !!topLayerColor,
          lastSegmentColor: safeGetHexString(lastSegmentColor, '#FFFF00'),
          highlightLastSegment: !!lastSegmentColor,
          buildVolume: buildVolume,
          drawBuildVolume: !!buildVolume,
          backgroundColor: safeGetHexString(backgroundColor, initialBackgroundColor),
          boundingBoxColor: boundingBoxColor || '#FF00FF'
        };

        console.log('[UI] Current settings computed:', currentSettings);
        Object.assign(settings.value, currentSettings);
        preview.endLayer = countLayers;
        applyDevMode(enableDevMode.value);

        // Force render after UI update for zero-layer files
        if (countLayers === 0) {
          console.log('[UI] Zero layers detected, forcing render attempt');
          setTimeout(() => {
            try {
              if (preview) {
                preview.render();
              }
            } catch (error) {
              console.error('[UI] Error in forced render:', error);
            }
          }, 100);
        }

        console.log('[UI] UI update completed successfully');
      } catch (error) {
        console.error('[UI] Error updating UI:', error);
      }
    };

    const loadGCodeFromServer = async (filename) => {
      const currentToken = switchToken;
      console.log(`[LOAD] Starting G-code load for: ${filename} (token: ${currentToken})`);

      try {
        // Generate fresh URL right before fetch for dynamic URLs
        const finalUrl = filename.includes('localhost:2727')
          ? getFreshUrl(filename)
          : filename;

        console.log(`[LOAD] Final URL: ${finalUrl}`);
        console.log(`[LOAD] Making fetch request`);

        const response = await fetch(finalUrl, { cache: 'no-store' });
        console.log(`[LOAD] Fetch response status: ${response.status}`);

        // Check if we've been superseded
        if (currentToken !== switchToken) {
          console.log(`[LOAD] Load operation cancelled - preset switched (current: ${currentToken}, latest: ${switchToken})`);
          return;
        }

        if (response.status !== 200) {
          console.error(`[LOAD] HTTP Error. Status Code: ${response.status}`);
          return;
        }

        console.log('[LOAD] Setting up G-code stream processing');
        const gcodeStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TransformStream({
            transform(chunk, controller) {
              const cleaned = chunk.replace(/^N\d+\s+/gm, "");
              controller.enqueue(cleaned);
            }
          }));

        // Check token again before processing
        if (currentToken !== switchToken) {
          console.log(`[LOAD] Load operation cancelled during stream setup (current: ${currentToken}, latest: ${switchToken})`);
          return;
        }

        if (!preview) {
          console.error('[LOAD] Preview is null, cannot process G-code');
          return;
        }

        console.log('[LOAD] Starting G-code processing');
        const prevDevMode = preview.devMode;
        preview.devMode = prevDevMode;

        // Process with render: true to ensure proper initialization
        await preview.processGCode(gcodeStream, { render: true });
        console.log('[LOAD] G-code processing completed');

        // Check token after processing
        if (currentToken !== switchToken) {
          console.log(`[LOAD] Load operation cancelled after processing (current: ${currentToken}, latest: ${switchToken})`);
          return;
        }

        // Final token check before UI update
        if (currentToken === switchToken) {
          console.log('[LOAD] Updating UI after successful G-code load');
          await updateUI();
          console.log('[LOAD] G-code load and UI update completed successfully');
        } else {
          console.log(`[LOAD] Skipping UI update - token mismatch (current: ${currentToken}, latest: ${switchToken})`);
        }

      } catch (error) {
        console.error('[LOAD] Error processing G-code:', error);
        console.error('[LOAD] Error stack:', error.stack);
      }
    };

    const render = async () => {
      console.log(`[RENDER] Starting render (progressive: ${loadProgressive.value})`);
      try {
        if (!preview) {
          console.error('[RENDER] Preview is null, cannot render');
          return;
        }

        if (loadProgressive.value && preview.job && preview.job.layers !== null) {
          console.log('[RENDER] Using animated rendering');
          await preview.renderAnimated();
        } else {
          console.log('[RENDER] Using standard rendering');
          preview.render();
        }
        console.log('[RENDER] Render completed');
      } catch (error) {
        console.error('[RENDER] Error during render:', error);
      }
    };

    const selectPreset = async (presetName) => {
      const myToken = ++switchToken;

      console.log(`[PRESET] ========== Starting preset switch to: ${presetName} (token: ${myToken}) ==========`);

      try {
        const canvas = document.querySelector('canvas.preview');
        if (!canvas) {
          console.error('[PRESET] Canvas element not found');
          return;
        }
        console.log('[PRESET] Canvas element found');

        const preset = presets.value[presetName];
        if (!preset) {
          console.error(`[PRESET] Preset not found: ${presetName}`);
          console.log(`[PRESET] Available presets: ${Object.keys(presets.value).join(', ')}`);
          return;
        }
        console.log(`[PRESET] Preset found:`, preset);

        model.value = preset.model;

        // Early exit if superseded
        if (myToken !== switchToken) {
          console.log(`[PRESET] Preset switch cancelled - superseded before disposal (${myToken} vs ${switchToken})`);
          return;
        }

        // Clear old UI + dispose old preview with async cleanup
        console.log('[PRESET] Starting disposal of previous preview');
        await disposePreview();
        console.log('[PRESET] Previous preview disposed');

        // Check token after disposal
        if (myToken !== switchToken) {
          console.log(`[PRESET] Preset switch cancelled - superseded after disposal (${myToken} vs ${switchToken})`);
          return;
        }

        // Cascade settings: first defaults, then preset, then overrides
        const options = {
          ...defaultSettings,
          ...preset,
          canvas,
          droppable: true,
          backgroundColor: initialBackgroundColor
        };
        console.log('[PRESET] Preview options prepared:', options);

        // Init new preview
        console.log('[PRESET] Initializing new preview');
        window['_preview'] = preview = new GCodePreview.init(options);
        console.log('[PRESET] New preview initialized successfully');

        // Check token before observer setup
        if (myToken !== switchToken) {
          console.log(`[PRESET] Preset switch cancelled - superseded during init (${myToken} vs ${switchToken})`);
          await disposePreview();
          return;
        }

        // Resize observer
        console.log('[PRESET] Setting up resize observer');
        if (observer) {
          try {
            observer.disconnect();
            console.log('[PRESET] Previous observer disconnected');
          } catch (e) {
            console.log('[PRESET] Error disconnecting previous observer:', e);
          }
        }
        observer = new ResizeObserver(() => {
          if (myToken !== switchToken) {
            console.log(`[OBSERVER] Ignoring resize - outdated token (${myToken} vs ${switchToken})`);
            return;
          }
          console.log('[OBSERVER] Handling resize');
          if (preview) {
            preview.resize();
          }
        });
        observer.observe(canvas);
        console.log('[PRESET] Resize observer set up');

        // Apply dev mode
        console.log('[PRESET] Applying dev mode');
        applyDevMode(enableDevMode.value);

        // Get file URL
        const fileUrl = typeof preset.getFileUrl === 'function'
          ? preset.file // Use base URL, let loadGCodeFromServer handle cache-busting
          : preset.file;
        console.log(`[PRESET] File URL determined: ${fileUrl}`);

        // Check token before loading
        if (myToken !== switchToken) {
          console.log(`[PRESET] Preset switch cancelled - superseded before load (${myToken} vs ${switchToken})`);
          return;
        }

        // Load gcode fresh
        console.log('[PRESET] Starting G-code load');
        await loadGCodeFromServer(fileUrl);

        // Final reapply dev mode after load
        if (myToken === switchToken) {
          console.log('[PRESET] Reapplying dev mode after successful load');
          applyDevMode(enableDevMode.value);
          console.log(`[PRESET] ========== Successfully completed preset switch to: ${presetName} ==========`);
        } else {
          console.log(`[PRESET] Preset switch completed but was superseded (${myToken} vs ${switchToken})`);
        }
      } catch (error) {
        console.error(`[PRESET] Error during preset switch to ${presetName}:`, error);
        console.error('[PRESET] Error stack:', error.stack);
      }
    };

    function applyDevMode(enabled) {
      console.log(`[DEV] Applying dev mode: ${enabled}`);
      const elements = document.querySelectorAll('.lil-gui, .stats');
      console.log(`[DEV] Found ${elements.length} dev mode elements`);
      elements.forEach((el) => (el.style.display = enabled ? 'block' : 'none'));
    }

    watch(enableDevMode, (newValue) => {
      console.log(`[WATCH] Dev mode changed to: ${newValue}`);
      applyDevMode(newValue);
    });

    onMounted(async () => {
      console.log('[MOUNT] Component mounted, starting initialization');

      try {
        console.log('[MOUNT] Fetching presets');
        await fetchPresets();

        console.log(`[MOUNT] Selecting default preset: ${defaultPreset}`);
        await selectPreset(defaultPreset);

        console.log('[MOUNT] Setting up watchers');

        watchEffect(() => {
          if (!preview) {
            console.log('[WATCH-EFFECT] Preview not available, skipping background/volume update');
            return;
          }
          console.log('[WATCH-EFFECT] Updating background and build volume');
          try {
            preview.backgroundColor = settings.value.backgroundColor;
            if (preview.buildVolume && settings.value.drawBuildVolume) {
              preview.buildVolume.smallGrid = settings.value.buildVolume.smallGrid;
              preview.buildVolume.x = +settings.value.buildVolume.x;
              preview.buildVolume.y = +settings.value.buildVolume.y;
              preview.buildVolume.z = +settings.value.buildVolume.z;
            }
            if (!preview.buildVolume && settings.value.drawBuildVolume) {
              preview.buildVolume = {
                x: +settings.value.buildVolume.x,
                y: +settings.value.buildVolume.y,
                z: +settings.value.buildVolume.z,
                smallGrid: settings.value.buildVolume.smallGrid
              };
            } else if (preview.buildVolume && !settings.value.drawBuildVolume) {
              preview.buildVolume = undefined;
            }
            preview.boundingBoxColor = drawBoundingBox.value ? (settings.value.boundingBoxColor ?? 'magenta') : undefined;
          } catch (error) {
            console.error('[WATCH-EFFECT] Error updating background/volume:', error);
          }
        });

        watchEffect(() => {
          if (!preview) {
            console.log('[WATCH-EFFECT] Preview not available, skipping render settings update');
            return;
          }
          console.log('[WATCH-EFFECT] Updating render settings');
          try {
            preview.renderTravel = settings.value.renderTravel;
            preview.travelColor = settings.value.travelColor;
            preview.lineWidth = +settings.value.lineWidth;
            preview.renderExtrusion = settings.value.renderExtrusion;
            preview.renderTubes = settings.value.renderTubes;
            preview.extrusionWidth = +settings.value.extrusionWidth;
            preview.topLayerColor = settings.value.highlightTopLayer ? settings.value.topLayerColor : undefined;
            preview.lastSegmentColor = settings.value.highlightLastSegment ? settings.value.lastSegmentColor : undefined;
            // run render after settings have been applied
            setTimeout(() => {
              render();
            }, 0);
          } catch (error) {
            console.error('[WATCH-EFFECT] Error updating render settings:', error);
          }
        });

        watchEffect(() => {
          if (!preview) {
            console.log('[WATCH-EFFECT] Preview not available, skipping layer settings update');
            return;
          }
          console.log('[WATCH-EFFECT] Updating layer settings');
          try {
            const startLayer = parseIntOrDefault(settings.value.startLayer, undefined);
            const endLayer = parseIntOrDefault(settings.value.endLayer, undefined);
            preview.startLayer = settings.value.enableStartLayer ? startLayer : undefined;
            preview.endLayer = settings.value.enableEndLayer ? endLayer : undefined;
          } catch (error) {
            console.error('[WATCH-EFFECT] Error updating layer settings:', error);
          }
        });

        watchEffect(() => {
          if (!preview) {
            console.log('[WATCH-EFFECT] Preview not available, skipping single layer mode update');
            return;
          }
          console.log('[WATCH-EFFECT] Updating single layer mode');
          try {
            preview.singleLayerMode = settings.value.singleLayerMode;
          } catch (error) {
            console.error('[WATCH-EFFECT] Error updating single layer mode:', error);
          }
        });

        watchEffect(() => {
          if (!preview) {
            console.log('[WATCH-EFFECT] Preview not available, skipping extrusion color update');
            return;
          }
          console.log('[WATCH-EFFECT] Updating extrusion colors');
          try {
            preview.extrusionColor = settings.value.colors.length === 1 ? settings.value.colors[0] : settings.value.colors;
          } catch (error) {
            console.error('[WATCH-EFFECT] Error updating extrusion colors:', error);
          }
        });

        console.log('[MOUNT] Initialization completed successfully');
      } catch (error) {
        console.error('[MOUNT] Error during initialization:', error);
        console.error('[MOUNT] Error stack:', error.stack);
      }
    });

    return {
      presets,
      activeTab,
      selectedPreset,
      thumbnail,
      layerCount,
      fileSize,
      model,
      dragging,
      settings,
      loadProgressive,
      enableDevMode,
      drawBoundingBox,
      selectTab,
      addColor,
      removeColor,
      update,
      resetUI: updateUI,
      loadGCodeFromServer,
      selectPreset
    };
  }
}).mount('#app'));

import { createApp, ref, watch, onMounted, onUnmounted, watchEffect, readonly, computed } from 'vue';
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

let gcodeVersions = {
  original: '',
  emulated3D: '',
  currentMode: null
};

let multicolorData = {
  toolColors: new Map(),
  currentTool: 0,
  detectedTools: new Set(),
  defaultColors: [
    '#95dfa1', '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE',
    '#FF9F40', '#FF6384', '#36A2EB', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#4BC0C0'
  ]
};

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

const convertColorName = (colorName) => {
  if (!colorName || typeof colorName !== 'string') return null;

  const colorMap = {
    'red': '#FF0000', 'blue': '#0000FF', 'green': '#00FF00', 'yellow': '#FFFF00',
    'magenta': '#FF00FF', 'cyan': '#00FFFF', 'black': '#000000', 'white': '#FFFFFF',
    'orange': '#FFA500', 'purple': '#800080', 'pink': '#FFC0CB', 'brown': '#A52A2A',
    'gray': '#808080', 'grey': '#808080', 'lime': '#00FF00', 'navy': '#000080',
    'teal': '#008080', 'silver': '#C0C0C0', 'maroon': '#800000', 'olive': '#808000'
  };

  return colorMap[colorName.toLowerCase()] || null;
};

const parseColorFromComment = (line) => {
  if (!line || typeof line !== 'string') return null;

  const colorCommentMatch1 = line.match(/;\s*Tool change for color:\s*(\w+)/i);
  if (colorCommentMatch1) {
    return convertColorName(colorCommentMatch1[1]);
  }

  const colorCommentMatch2 = line.match(/;\s*T?(?:ool\s+)?(\d+)\s*:\s*(\w+)/i);
  if (colorCommentMatch2) {
    return convertColorName(colorCommentMatch2[2]);
  }

  const colorCommentMatch3 = line.match(/;\s*COLOR\s*[=:]\s*(\w+)/i);
  if (colorCommentMatch3) {
    return convertColorName(colorCommentMatch3[1]);
  }

  const hexCommentMatch = line.match(/;\s*T?(?:ool\s+)?\d*\s*[:#]([A-Fa-f0-9]{6})/);
  if (hexCommentMatch) {
    return `#${hexCommentMatch[1]}`;
  }

  return null;
};

const assignToolColor = (toolNumber) => {
  if (!multicolorData.toolColors.has(toolNumber)) {
    const colorIndex = Array.from(multicolorData.detectedTools).indexOf(toolNumber);
    const finalIndex = colorIndex >= 0 ? colorIndex : multicolorData.detectedTools.size;
    const assignedColor = multicolorData.defaultColors[finalIndex % multicolorData.defaultColors.length];

    multicolorData.toolColors.set(toolNumber, assignedColor);
    console.log(`[MULTICOLOR] Tool T${toolNumber} assigned color ${assignedColor}`);
    return assignedColor;
  }

  return multicolorData.toolColors.get(toolNumber);
};

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

const getFreshUrl = (url) => {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_t=${Date.now()}&_r=${Math.random().toString(36).slice(2)}`;
};

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

    const showGallery = ref(false);
    const selectedItem = ref(null);
    const hasInitialized = ref(false);

    const currentSkip = ref(0);
    const itemsPerLoad = ref(100);
    const isLoading = ref(false);
    const hasMorePresets = ref(true);

    const keyboardNavigation = ref({
      enabled: true,
      focusedElement: null,
      showHelpOverlay: false
    });

    const cameraControls = ref({
      moveSpeed: 10,
      rotateSpeed: 0.1,
      zoomSpeed: 5
    });

    const mousePosition = ref({ x: 0, y: 0 });
    const isMouseOverCanvas = ref(false);

    const multicolorInfo = ref({
      toolCount: 0,
      colors: [],
      isMulticolor: false
    });

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

    const navigatePresets = (direction) => {
      console.log(`[KEYBOARD] Navigating presets: ${direction}`);
      const presetKeys = Object.keys(presets.value);
      const currentIndex = presetKeys.indexOf(selectedPreset.value);

      console.log(`[KEYBOARD] Current preset: ${selectedPreset.value}, index: ${currentIndex}, total: ${presetKeys.length}`);

      if (currentIndex === -1) {
        console.warn('[KEYBOARD] Current preset not found in list');
        return;
      }

      let newIndex;
      if (direction === 'next') {
        newIndex = (currentIndex + 1) % presetKeys.length;
      } else {
        newIndex = currentIndex === 0 ? presetKeys.length - 1 : currentIndex - 1;
      }

      const newPreset = presetKeys[newIndex];
      console.log(`[KEYBOARD] Switching to preset: ${newPreset} (index: ${newIndex})`);
      selectedPreset.value = newPreset;
    };

    const resetCameraView = () => {
      console.log('[KEYBOARD] Resetting camera view');
      if (!preview || !preview.camera) {
        console.warn('[KEYBOARD] Preview or camera not available');
        return;
      }

      try {
        const preset = presets.value[selectedPreset.value];
        if (preset && preset.initialCameraPosition) {
          const [x, y, z] = preset.initialCameraPosition;
          preview.camera.position.set(x, y, z);
          console.log(`[KEYBOARD] Set camera to preset position: [${x}, ${y}, ${z}]`);
        } else {
          preview.camera.position.set(50, 50, 150);
          console.log('[KEYBOARD] Set camera to default position: [50, 50, 150]');
        }

        if (preview.controls && preview.controls.target) {
          preview.controls.target.set(0, 0, 0);
          preview.controls.update();
        }

        simpleRender();
        console.log('[KEYBOARD] Camera reset complete');
      } catch (error) {
        console.error('[KEYBOARD] Camera reset error:', error);
      }
    };

    const fitToScreen = () => {
      if (!preview || !preview.camera || !preview.scene) return;

      const box = new window.THREE.Box3();
      box.setFromObject(preview.scene);

      const center = box.getCenter(new window.THREE.Vector3());
      const size = box.getSize(new window.THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = preview.camera.fov * (Math.PI / 180);
      const distance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.2;

      // Move camera to look at the model center
      preview.camera.position.copy(center);
      preview.camera.position.z += distance;

      if (preview.controls && preview.controls.target) {
        preview.controls.target.copy(center);
        preview.controls.update();
      }
    };

    const zoomTowardMouse = (deltaZ) => {
      if (!preview || !preview.camera || typeof window.THREE === 'undefined') {
        preview.camera.position.z += deltaZ;
        if (preview.controls) preview.controls.update();
        simpleRender();
        return;
      }

      try {
        const canvas = document.querySelector('canvas.preview');
        if (!canvas) {
          preview.camera.position.z += deltaZ;
          if (preview.controls) preview.controls.update();
          simpleRender();
          return;
        }

        const rect = canvas.getBoundingClientRect();

        const mouse = new window.THREE.Vector2();
        mouse.x = ((mousePosition.value.x - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((mousePosition.value.y - rect.top) / rect.height) * 2 + 1;

        const raycaster = new window.THREE.Raycaster();
        raycaster.setFromCamera(mouse, preview.camera);

        const intersects = raycaster.intersectObjects(preview.scene.children, true);

        let targetPoint;
        if (intersects.length > 0) {
          targetPoint = intersects[0].point.clone();
        } else {
          const rayDirection = raycaster.ray.direction.clone();
          const currentDistance = preview.controls && preview.controls.target
            ? preview.camera.position.distanceTo(preview.controls.target)
            : 100;

          targetPoint = preview.camera.position.clone()
            .add(rayDirection.multiplyScalar(currentDistance));
        }

        const cameraToTarget = new window.THREE.Vector3();
        cameraToTarget.subVectors(targetPoint, preview.camera.position);
        const currentDistance = cameraToTarget.length();

        const baseStepSize = cameraControls.value.zoomSpeed;
        const minDistance = 1.0;
        const maxDistance = 1000;

        let moveDistance;
        if (deltaZ < 0) {
          moveDistance = Math.min(baseStepSize, Math.max(0, currentDistance - minDistance));
        } else {
          moveDistance = baseStepSize;
        }

        if (currentDistance <= minDistance && deltaZ < 0) {
          console.log('[ZOOM] Already at minimum distance, ignoring zoom in');
          return;
        }

        if (currentDistance >= maxDistance && deltaZ > 0) {
          console.log('[ZOOM] Already at maximum distance, ignoring zoom out');
          return;
        }

        if (currentDistance > 0.001) {
          cameraToTarget.normalize();
          const moveVector = cameraToTarget.multiplyScalar(deltaZ < 0 ? moveDistance : -moveDistance);
          preview.camera.position.add(moveVector);

          if (preview.controls && preview.controls.target && intersects.length > 0) {
            preview.controls.target.copy(targetPoint);
          }

          if (preview.controls) {
            preview.controls.update();
          }

          simpleRender();

          console.log(`[ZOOM] ${deltaZ < 0 ? 'In' : 'Out'} - Distance: ${currentDistance.toFixed(2)} -> ${preview.camera.position.distanceTo(targetPoint).toFixed(2)}`);
        }

      } catch (error) {
        console.error('[ZOOM] Mouse zoom error:', error);
        preview.camera.position.z += deltaZ;
        if (preview.controls) preview.controls.update();
        simpleRender();
      }
    };

    const moveCameraBy = (deltaX, deltaY, deltaZ, useMousePosition = false) => {
      console.log(`[KEYBOARD] Moving camera by: [${deltaX}, ${deltaY}, ${deltaZ}], mouse-aware: ${useMousePosition}`);
      if (!preview || !preview.camera) {
        console.warn('[KEYBOARD] Preview or camera not available for movement');
        return;
      }

      try {
        if (deltaZ !== 0 && useMousePosition && isMouseOverCanvas.value) {
          zoomTowardMouse(deltaZ);
        } else {
          const oldPos = preview.camera.position.clone();
          preview.camera.position.x += deltaX;
          preview.camera.position.y += deltaY;
          preview.camera.position.z += deltaZ;

          console.log(`[KEYBOARD] Camera moved from [${oldPos.x}, ${oldPos.y}, ${oldPos.z}] to [${preview.camera.position.x}, ${preview.camera.position.y}, ${preview.camera.position.z}]`);

          if (preview.controls) {
            preview.controls.update();
          }
          simpleRender();
        }
      } catch (error) {
        console.error('[KEYBOARD] Camera movement error:', error);
      }
    };

    const changeLayer = (direction, type = 'end') => {
      const increment = direction === 'up' ? 1 : -1;
      console.log(`[KEYBOARD] Changing ${type} layer by ${increment}`);

      if (type === 'end' && settings.value.enableEndLayer) {
        const oldValue = settings.value.endLayer;
        const newValue = settings.value.endLayer + increment;
        settings.value.endLayer = Math.max(1, Math.min(newValue, layerCount.value));
        console.log(`[KEYBOARD] End layer changed from ${oldValue} to ${settings.value.endLayer}`);
      } else if (type === 'start' && settings.value.enableStartLayer) {
        const oldValue = settings.value.startLayer;
        const newValue = settings.value.startLayer + increment;
        settings.value.startLayer = Math.max(1, Math.min(newValue, layerCount.value));
        console.log(`[KEYBOARD] Start layer changed from ${oldValue} to ${settings.value.startLayer}`);
      } else {
        console.log(`[KEYBOARD] Layer change skipped - ${type} layer not enabled`);
        return;
      }

      simpleRender();
    };

    const toggleSetting = (settingName, displayName) => {
      const oldValue = settings.value[settingName];
      settings.value[settingName] = !oldValue;
      console.log(`[KEYBOARD] Toggled ${displayName}: ${oldValue} -> ${settings.value[settingName]}`);
      simpleRender();
    };

    const handleMouseMove = (e) => {
      mousePosition.value = { x: e.clientX, y: e.clientY };
    };

    const handleMouseEnter = () => {
      isMouseOverCanvas.value = true;
      console.log('[MOUSE] Mouse entered canvas');
    };

    const handleMouseLeave = () => {
      isMouseOverCanvas.value = false;
      console.log('[MOUSE] Mouse left canvas');
    };

    const handleWheel = (e) => {
      if (!isMouseOverCanvas.value || !keyboardNavigation.value.enabled) return;
      e.preventDefault();

      const deltaZ = e.deltaY > 0 ? cameraControls.value.zoomSpeed : -cameraControls.value.zoomSpeed;
      console.log(`[WHEEL] Mouse wheel zoom: ${deltaZ}`);
      zoomTowardMouse(deltaZ);
    };

    const setupOrbitControls = () => {
      if (!preview || !preview.controls) return;

      try {
        const controls = preview.controls;

        if (controls.zoomToCursor !== undefined) {
          controls.zoomToCursor = true;
          console.log('[CONTROLS] Enabled zoomToCursor on OrbitControls');
        }

        if (controls.minDistance !== undefined) {
          controls.minDistance = 1;
        }

        if (controls.maxDistance !== undefined) {
          controls.maxDistance = 1000;
        }

        if (controls.enableZoom !== undefined) {
          controls.enableZoom = true;
        }

        if (controls.zoomSpeed !== undefined) {
          controls.zoomSpeed = 0.5;
        }

        if (controls.panSpeed !== undefined) {
          controls.panSpeed = 2.0;
        }

        if (controls.rotateSpeed !== undefined) {
          controls.rotateSpeed = 1.0;
        }

        if (controls.enableDamping !== undefined) {
          controls.enableDamping = true;
          controls.dampingFactor = 0.05;
        }

        console.log('[CONTROLS] Enhanced OrbitControls configured for optimal zoom behavior');

      } catch (error) {
        console.error('[CONTROLS] Error setting up enhanced orbit controls:', error);
      }
    };

    const keyboardShortcuts = {
      'g': () => {
        console.log('[KEYBOARD] Gallery toggle pressed');
        showGallery.value ? closeGallery() : openGallery();
      },
      'Escape': () => {
        console.log('[KEYBOARD] Escape pressed');
        if (keyboardNavigation.value.showHelpOverlay) {
          keyboardNavigation.value.showHelpOverlay = false;
        } else if (showGallery.value) {
          closeGallery();
        }
      },

      '1': () => {
        console.log('[KEYBOARD] Tab 1 pressed - layers');
        selectTab('layers');
      },
      '2': () => {
        console.log('[KEYBOARD] Tab 2 pressed - travel');
        selectTab('travel');
      },
      '3': () => {
        console.log('[KEYBOARD] Tab 3 pressed - extrusion');
        selectTab('extrusion');
      },

      'ArrowUp': (e) => {
        e.preventDefault();
        console.log(`[KEYBOARD] Arrow Up pressed ${e.shiftKey ? 'with Shift' : ''}`);
        if (e.shiftKey) {
          changeLayer('up', 'start');
        } else {
          changeLayer('up', 'end');
        }
      },
      'ArrowDown': (e) => {
        e.preventDefault();
        console.log(`[KEYBOARD] Arrow Down pressed ${e.shiftKey ? 'with Shift' : ''}`);
        if (e.shiftKey) {
          changeLayer('down', 'start');
        } else {
          changeLayer('down', 'end');
        }
      },
      'ArrowLeft': (e) => {
        e.preventDefault();
        console.log(`[KEYBOARD] Arrow Left pressed ${e.ctrlKey || e.metaKey ? 'with Ctrl/Cmd' : ''}`);
        if (e.ctrlKey || e.metaKey) {
          moveCameraBy(-cameraControls.value.moveSpeed, 0, 0);
        } else {
          navigatePresets('previous');
        }
      },
      'ArrowRight': (e) => {
        e.preventDefault();
        console.log(`[KEYBOARD] Arrow Right pressed ${e.ctrlKey || e.metaKey ? 'with Ctrl/Cmd' : ''}`);
        if (e.ctrlKey || e.metaKey) {
          moveCameraBy(cameraControls.value.moveSpeed, 0, 0);
        } else {
          navigatePresets('next');
        }
      },

      'p': () => {
        console.log('[KEYBOARD] P pressed - previous preset');
        navigatePresets('previous');
      },
      'n': () => {
        console.log('[KEYBOARD] N pressed - next preset');
        navigatePresets('next');
      },

      'r': () => {
        console.log('[KEYBOARD] R pressed - reset camera');
        resetCameraView();
      },
      'f': () => {
        console.log('[KEYBOARD] F pressed - fit to screen');
        fitToScreen();
      },

      'w': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] W pressed - move up');
        moveCameraBy(0, cameraControls.value.moveSpeed, 0);
      },
      'a': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] A pressed - move left');
        moveCameraBy(-cameraControls.value.moveSpeed, 0, 0);
      },
      's': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] S pressed - move down');
        moveCameraBy(0, -cameraControls.value.moveSpeed, 0);
      },
      'd': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] D pressed - move right');
        moveCameraBy(cameraControls.value.moveSpeed, 0, 0);
      },
      'q': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] Q pressed - zoom in (mouse-aware)');
        moveCameraBy(0, 0, -cameraControls.value.zoomSpeed, true);
      },
      'e': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] E pressed - zoom out (mouse-aware)');
        moveCameraBy(0, 0, cameraControls.value.zoomSpeed, true);
      },

      't': () => {
        console.log('[KEYBOARD] T pressed - toggle travel');
        toggleSetting('renderTravel', 'travel rendering');
      },
      'x': () => {
        console.log('[KEYBOARD] X pressed - toggle extrusion');
        toggleSetting('renderExtrusion', 'extrusion rendering');
      },
      'b': () => {
        console.log('[KEYBOARD] B pressed - toggle build volume');
        toggleSetting('drawBuildVolume', 'build volume display');
      },
      'l': () => {
        console.log('[KEYBOARD] L pressed - toggle single layer mode');
        toggleSetting('singleLayerMode', 'single layer mode');
      },

      '[': () => {
        console.log('[KEYBOARD] [ pressed - toggle start layer');
        toggleSetting('enableStartLayer', 'start layer control');
      },
      ']': () => {
        console.log('[KEYBOARD] ] pressed - toggle end layer');
        toggleSetting('enableEndLayer', 'end layer control');
      },

      'F12': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] F12 pressed - toggle dev mode');
        enableDevMode.value = !enableDevMode.value;
      },
      'h': () => {
        console.log('[KEYBOARD] H pressed - toggle help');
        keyboardNavigation.value.showHelpOverlay = !keyboardNavigation.value.showHelpOverlay;
      },
      '?': () => {
        console.log('[KEYBOARD] ? pressed - toggle help');
        keyboardNavigation.value.showHelpOverlay = !keyboardNavigation.value.showHelpOverlay;
      },

      'PageUp': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] PageUp pressed - skip 5 presets back');
        for (let i = 0; i < 5; i++) {
          navigatePresets('previous');
        }
      },
      'PageDown': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] PageDown pressed - skip 5 presets forward');
        for (let i = 0; i < 5; i++) {
          navigatePresets('next');
        }
      },

      'End': (e) => {
        e.preventDefault();
        console.log('[KEYBOARD] End pressed - jump to last layer');
        if (settings.value.enableEndLayer) {
          const oldValue = settings.value.endLayer;
          settings.value.endLayer = layerCount.value;
          console.log(`[KEYBOARD] End layer set from ${oldValue} to ${settings.value.endLayer}`);
          simpleRender();
        }
      },
      'Home': (e) => {
        e.preventDefault();
        console.log(`[KEYBOARD] Home pressed ${e.shiftKey ? 'with Shift' : ''}`);
        if (e.shiftKey && settings.value.enableStartLayer) {
          const oldValue = settings.value.startLayer;
          settings.value.startLayer = 1;
          console.log(`[KEYBOARD] Start layer set from ${oldValue} to 1`);
          simpleRender();
        } else {
          resetCameraView();
        }
      }
    };

    const handleKeydown = (e) => {
      console.log(`[KEYBOARD DEBUG] Key pressed: "${e.key}", enabled: ${keyboardNavigation.value.enabled}, target: ${e.target.tagName}`);

      if (!keyboardNavigation.value.enabled) {
        console.log('[KEYBOARD DEBUG] Navigation disabled, ignoring key');
        return;
      }

      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        console.log('[KEYBOARD DEBUG] Ignoring - user typing in input field');
        return;
      }

      const key = e.key;
      const handler = keyboardShortcuts[key];

      if (handler) {
        console.log(`[KEYBOARD DEBUG] Executing handler for key: "${key}"`);
        try {
          handler(e);
          console.log(`[KEYBOARD DEBUG] Handler executed successfully for key: "${key}"`);
        } catch (error) {
          console.error(`[KEYBOARD] Error handling key ${key}:`, error);
        }
      }
    };

    const toggleKeyboardNavigation = () => {
      keyboardNavigation.value.enabled = !keyboardNavigation.value.enabled;
      console.log(`[KEYBOARD] Navigation ${keyboardNavigation.value.enabled ? 'enabled' : 'disabled'}`);
    };

    const testKeyboard = () => {
      console.log('[KEYBOARD TEST] Testing keyboard navigation');
      console.log('Current state:', keyboardNavigation.value);
      console.log('Available presets:', Object.keys(presets.value));
      console.log('Current preset:', selectedPreset.value);
      console.log('Preview available:', !!preview);
      navigatePresets('next');
    };

    const forceEnableKeyboard = () => {
      keyboardNavigation.value.enabled = true;
      console.log('[KEYBOARD] Force enabled keyboard navigation');
    };

    const debugKeyboardState = () => {
      console.log('[KEYBOARD DEBUG] Full state dump:', {
        enabled: keyboardNavigation.value.enabled,
        hasPreview: !!preview,
        selectedPreset: selectedPreset.value,
        presetCount: Object.keys(presets.value).length,
        shortcuts: Object.keys(keyboardShortcuts),
        layerCount: layerCount.value,
        mouseOverCanvas: isMouseOverCanvas.value,
        mousePosition: mousePosition.value,
        multicolor: multicolorInfo.value,
        settings: {
          enableStartLayer: settings.value.enableStartLayer,
          enableEndLayer: settings.value.enableEndLayer,
          startLayer: settings.value.startLayer,
          endLayer: settings.value.endLayer
        },
        camera: preview ? {
          position: preview.camera ? [preview.camera.position.x, preview.camera.position.y, preview.camera.position.z] : 'no camera',
          hasControls: !!preview.controls
        } : 'no preview'
      });
    };

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

    const initializeGalleryFromUrl = () => {
      const shouldShowGallery = getGalleryQueryParam();
      if (shouldShowGallery !== showGallery.value) {
        console.log(`[APP] Setting gallery visibility from URL: ${shouldShowGallery}`);
        showGallery.value = shouldShowGallery;
      }
    };

    watch(showGallery, (newValue) => {
      if (hasInitialized.value) {
        console.log(`[APP] Gallery state changed: ${newValue}, updating URL`);
        setGalleryQueryParam(newValue);
      }
    });

    const loadSelectedItemFromUrl = () => {
      const selectedParam = getQueryParam('selectedItem');
      if (selectedParam && presets.value[selectedParam]) {
        console.log(`[APP] Loading selected item from URL: ${selectedParam}`);
        selectedItem.value = selectedParam;
        selectedPreset.value = selectedParam;
        return true;
      } else if (selectedParam) {
        console.warn(`[APP] Selected item ${selectedParam} not found in presets, will try to load more`);
        return selectedParam;
      }
      return false;
    };

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

    const initializeSelection = async () => {
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

      const selectedParam = getQueryParam('selectedItem');
      if (selectedParam) {
        if (presets.value[selectedParam]) {
          console.log(`[APP] Found URL selection in loaded presets: ${selectedParam}`);
          selectedItem.value = selectedParam;
          selectedPreset.value = selectedParam;
          hasInitialized.value = true;
          return selectedParam;
        } else {
          console.log(`[APP] URL selection '${selectedParam}' not found in current presets, attempting to load more...`);

          const found = await loadMorePresetsUntilFound(selectedParam, 3);

          if (found && presets.value[selectedParam]) {
            console.log(`[APP] Found URL selection after loading more presets: ${selectedParam}`);
            selectedItem.value = selectedParam;
            selectedPreset.value = selectedParam;
            hasInitialized.value = true;
            return selectedParam;
          } else {
            console.warn(`[APP] URL selection '${selectedParam}' not found after loading attempts`);
            console.log(`[APP] Preserving URL parameter but loading default preset for now`);
            selectedItem.value = selectedParam;
            selectedPreset.value = defaultPreset;
            hasInitialized.value = true;
            return defaultPreset;
          }
        }
      } else {
        console.log(`[APP] No URL selection found, using default: ${defaultPreset}`);
        selectedItem.value = defaultPreset;
        selectedPreset.value = defaultPreset;
        hasInitialized.value = true;
        return defaultPreset;
      }
    };

    watch(selectedItem, (newItem) => {
      if (newItem && hasInitialized.value) {
        console.log(`[APP] Updating URL with selected item: ${newItem}`);
        setQueryParam('selectedItem', newItem);
      }
    });

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
          emulate3DPlotting: false,
          travelColor: '#00FFFF'
        };

        const newPresets = {};
        apiPresets.forEach(item => {
          newPresets[item.filename] = {
            title: item.filename,
            file: item.url,
            getFileUrl: () => getFreshUrl(item.url),
            model: {
              name: item.filename,
              original: item.url,
              designer: "budavariam",
              license: "MIT",
            },
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

    const loadMorePresets = async () => {
      if (!hasMorePresets.value || isLoading.value) {
        console.log('[API] No more presets to load or already loading');
        return;
      }
      await fetchPresets(true);
    };

    const resetPresets = async () => {
      currentSkip.value = 0;
      hasMorePresets.value = true;
      presets.value = { ...localPresets };
      await fetchPresets(false);
    };

    const openGallery = () => {
      console.log('[APP] Opening gallery');
      showGallery.value = true;
    };

    const closeGallery = () => {
      console.log('[APP] Closing gallery');
      showGallery.value = false;
    };

    const selectPresetFromGallery = async (presetName) => {
      console.log(`[APP] Gallery selected preset: ${presetName}`);

      if (!presets.value[presetName]) {
        console.log(`[APP] Preset '${presetName}' not in current list, trying to load more...`);
        const found = await loadMorePresetsUntilFound(presetName);

        if (!found) {
          console.error(`[APP] Could not find preset '${presetName}' after loading more presets`);
          return;
        }
      }

      selectedItem.value = presetName;
      selectPreset(presetName);
    };

    watch(selectedPreset, (preset) => {
      if (!hasInitialized.value) {
        console.log('[APP] Skipping preset change before initialization');
        return;
      }

      if (presetSwitchTimeout) clearTimeout(presetSwitchTimeout);
      presetSwitchTimeout = setTimeout(() => selectPreset(preset), 100);
    });

    const selectTab = (tab) => {
      console.log(`[UI] Selecting tab: ${tab}`);
      activeTab.value = tab;
    };

    const addColor = () => settings.value.colors.push('#000000');
    const removeColor = () => settings.value.colors.pop();
    const update = async (evt) => {
      model.value = { name: evt.detail.filename };
      applyDevMode(enableDevMode.value);
      updateUI();
    };

    const updateUI = async () => {
      if (!preview) return;

      try {
        const {
          parser, countLayers, extrusionColor, topLayerColor, lastSegmentColor,
          buildVolume, backgroundColor, singleLayerMode, renderTravel, emulate3DPlotting, travelColor,
          renderExtrusion, lineWidth, renderTubes, extrusionWidth, boundingBoxColor
        } = preview;

        if (!parser?.metadata) {
          console.warn('[UI] Parser or metadata missing');
          return;
        }

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

        let validColors;
        if (multicolorInfo.value.isMulticolor && multicolorInfo.value.colors.length > 0) {
          validColors = multicolorInfo.value.colors;
          console.log(`[UI] Using detected multicolor: ${validColors.length} colors`);
        } else {
          const colors = Array.isArray(extrusionColor) ? extrusionColor : [extrusionColor];
          validColors = colors.map(c => safeGetHexString(c, '#95dfa1'));
        }

        if (!validColors || validColors.length === 0) {
          validColors = ['#95dfa1'];
        }

        let finalBuildVolume = buildVolume;
        if (detectedBuildVolume.value) {
          finalBuildVolume = detectedBuildVolume.value;
          if (preview.buildVolume) {
            Object.assign(preview.buildVolume, detectedBuildVolume.value);
          }
        }

        const currentSettings = {
          startLayer: 1,
          plotMinZ: 0,
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
          drawBuildVolume: !!(finalBuildVolume && finalBuildVolume.x && finalBuildVolume.y),
          backgroundColor: safeGetHexString(backgroundColor, initialBackgroundColor),
          boundingBoxColor: safeGetHexString(boundingBoxColor, '#FF00FF')
        };

        Object.assign(settings.value, currentSettings);
        preview.endLayer = countLayers || 0;
        applyDevMode(enableDevMode.value);

        console.log(`[UI] Updated - layers: ${countLayers || 0}, colors: ${validColors.length}, multicolor: ${multicolorInfo.value.isMulticolor}`);
      } catch (error) {
        console.error('[UI] Error:', error);
      }
    };

    const loadGCodeFromServer = async (filename) => {
      const currentToken = switchToken;

      try {
        const finalUrl = filename.includes('localhost:2727') ? getFreshUrl(filename) : filename;
        const response = await fetch(finalUrl, { cache: 'no-store' });

        if (currentToken !== switchToken || response.status !== 200) return;
        if (currentToken !== switchToken || !preview) return;

        const bounds = {};
        let boundingBoxDetected = false;

        multicolorData.toolColors.clear();
        multicolorData.currentTool = 0;
        multicolorData.detectedTools.clear();

        gcodeVersions.original = '';
        gcodeVersions.emulated3D = '';

        const gcodeStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TransformStream({
            transform(chunk, controller) {
              let processedChunk = chunk.replace(/^N\d+\s+/gm, "");

              const lines = processedChunk.split('\n');
              const originalLines = [];
              const emulated3DLines = [];

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
                    console.log(`[BUILD-VOLUME] Detected: ${detectedBuildVolume.value.x}x${detectedBuildVolume.value.y}x${detectedBuildVolume.value.z}mm`);
                  }
                }

                const toolChangeMatch = trimmed.match(/^M06\s+T(\d+)(?:\s*:\s*(\w+))?/i);
                if (toolChangeMatch) {
                  const newTool = parseInt(toolChangeMatch[1]);
                  const inlineColor = toolChangeMatch[2];

                  multicolorData.currentTool = newTool;
                  multicolorData.detectedTools.add(newTool);

                  if (inlineColor) {
                    const convertedColor = convertColorName(inlineColor);
                    if (convertedColor) {
                      multicolorData.toolColors.set(newTool, convertedColor);
                    } else {
                      assignToolColor(newTool);
                    }
                  } else {
                    assignToolColor(newTool);
                  }

                  originalLines.push(`T${newTool}`);
                  emulated3DLines.push(`T${newTool}`);
                  continue;
                }

                const colorFromComment = parseColorFromComment(trimmed);
                if (colorFromComment && multicolorData.currentTool > 0) {
                  multicolorData.toolColors.set(multicolorData.currentTool, colorFromComment);
                }

                originalLines.push(trimmed);

                let emulated3DLine = trimmed;
                if (/^G1/.test(trimmed) && !/E/.test(trimmed)) {
                  emulated3DLine = `${trimmed} E1.0`;
                }
                emulated3DLines.push(emulated3DLine);
              }

              gcodeVersions.original += originalLines.join('\n') + '\n';
              gcodeVersions.emulated3D += emulated3DLines.join('\n') + '\n';

              const outputLines = settings.value.emulate3DPlotting ? emulated3DLines : originalLines;
              controller.enqueue(outputLines.join('\n'));
            }
          }));

        if (currentToken !== switchToken || !preview) return;

        await preview.processGCode(gcodeStream, { render: false });

        if (currentToken === switchToken) {
          gcodeVersions.currentMode = settings.value.emulate3DPlotting;

          if (multicolorData.detectedTools.size > 1) {
            const colorsArray = Array.from(multicolorData.toolColors.values());

            multicolorInfo.value = {
              toolCount: multicolorData.detectedTools.size,
              colors: colorsArray,
              isMulticolor: true
            };

            console.log(`[MULTICOLOR] Detected ${multicolorData.detectedTools.size} tools with colors:`, colorsArray);

            preview.extrusionColor = colorsArray;
            settings.value.colors = colorsArray;

          } else {
            multicolorInfo.value = {
              toolCount: multicolorData.detectedTools.size,
              colors: [],
              isMulticolor: false
            };
          }

          if (!boundingBoxDetected) {
            detectedBuildVolume.value = null;
          }

          await updateUI();
          setTimeout(() => simpleRender(), 100);
        }
      } catch (error) {
        console.error('[LOAD] Error:', error);
      }
    };

    const selectPreset = async (presetName) => {
      const myToken = ++switchToken;

      try {
        const canvas = document.querySelector('canvas.preview');
        if (!canvas) return;

        const preset = presets.value[presetName];
        if (!preset) return;

        if (hasInitialized.value) {
          selectedItem.value = presetName;
        }

        model.value = preset.model;
        if (myToken !== switchToken) return;

        detectedBuildVolume.value = null;

        multicolorInfo.value = {
          toolCount: 0,
          colors: [],
          isMulticolor: false
        };

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
          setupOrbitControls();
          fitToScreen();
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

    watch(() => settings.value.emulate3DPlotting, async (newValue) => {
      if (!preview || gcodeVersions.currentMode === newValue || !gcodeVersions.original) return;

      console.log(`[EMULATION] Switching to ${newValue ? '3D emulated' : 'original'} mode`);

      const gcodeToUse = newValue ? gcodeVersions.emulated3D : gcodeVersions.original;

      if (gcodeToUse) {
        try {
          const currentCanvas = document.querySelector('canvas.preview');
          if (!currentCanvas) return;

          if (preview) {
            try {
              preview.dispose();
            } catch (error) {
              console.error('[EMULATION] Disposal error:', error);
            }
          }

          document.querySelectorAll('.lil-gui, .stats').forEach(el => el.remove());

          await new Promise(resolve => setTimeout(resolve, 50));

          const preset = presets.value[selectedPreset.value];
          const options = {
            ...defaultSettings,
            ...preset,
            canvas: currentCanvas,
            droppable: true,
            backgroundColor: initialBackgroundColor,
            emulate3DPlotting: newValue
          };

          window['_preview'] = preview = new GCodePreview.init(options);

          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(gcodeToUse);
              controller.close();
            }
          });

          gcodeVersions.currentMode = newValue;

          await preview.processGCode(stream, { render: false });

          if (multicolorInfo.value.isMulticolor && multicolorInfo.value.colors.length > 0) {
            preview.extrusionColor = multicolorInfo.value.colors;
            settings.value.colors = multicolorInfo.value.colors;
          }

          setupOrbitControls();
          applyDevMode(enableDevMode.value);

          await updateUI();
          simpleRender();

          console.log(`[EMULATION] Successfully switched to ${newValue ? '3D emulated' : 'original'} mode`);
        } catch (error) {
          console.error('[EMULATION] Error switching modes:', error);
        }
      }
    });

    onMounted(async () => {
      try {
        console.log('[APP] Starting app initialization...');

        document.addEventListener('keydown', handleKeydown);
        window.addEventListener('keydown', handleKeydown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('wheel', handleWheel, { passive: false });

        if (document.body) {
          document.body.setAttribute('tabindex', '0');
          document.body.focus();
        }

        setTimeout(() => {
          const canvas = document.querySelector('canvas.preview');
          if (canvas) {
            canvas.setAttribute('tabindex', '0');
            canvas.addEventListener('mouseenter', handleMouseEnter);
            canvas.addEventListener('mouseleave', handleMouseLeave);
          }
        }, 2000);

        initializeGalleryFromUrl();

        await fetchPresets();
        console.log('[APP] Presets loaded');

        const selectedPresetName = await initializeSelection();
        console.log(`[APP] Selection initialized: ${selectedPresetName}`);

        await selectPreset(selectedPresetName);
        console.log(`[APP] Preset loaded: ${selectedPresetName}`);

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
              emulate3DPlotting: settings.value.emulate3DPlotting,
              travelColor: settings.value.travelColor,
              lineWidth: +settings.value.lineWidth,
              renderExtrusion: settings.value.renderExtrusion,
              renderTubes: settings.value.renderTubes,
              extrusionWidth: +settings.value.extrusionWidth,
              topLayerColor: settings.value.highlightTopLayer ? settings.value.topLayerColor : undefined,
              lastSegmentColor: settings.value.highlightLastSegment ? settings.value.lastSegmentColor : undefined
            });
            simpleRender();
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

        console.log('[APP] Initialization complete with zoom-to-cursor and multicolor functionality');

      } catch (error) {
        console.error('[MOUNT] Error:', error);
      }
    });

    onUnmounted(() => {
      console.log('[CLEANUP] Removing all event listeners');
      document.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('wheel', handleWheel);

      const canvas = document.querySelector('canvas.preview');
      if (canvas) {
        canvas.removeEventListener('mouseenter', handleMouseEnter);
        canvas.removeEventListener('mouseleave', handleMouseLeave);
      }
    });

    return {
      presets, activeTab, selectedPreset, thumbnail, layerCount, fileSize,
      model, dragging, settings, loadProgressive, enableDevMode, drawBoundingBox,
      detectedBuildVolume,
      selectTab, addColor, removeColor, update, resetUI: updateUI,
      loadGCodeFromServer, selectPreset,

      loadMorePresets,
      resetPresets,
      isLoading,
      hasMorePresets,
      currentSkip: readonly(currentSkip),

      showGallery,
      dynamicPresets,
      selectPresetFromGallery,
      openGallery,
      closeGallery,

      selectedItem: readonly(selectedItem),

      keyboardNavigation: readonly(keyboardNavigation),
      toggleKeyboardNavigation,
      navigatePresets,
      resetCameraView,
      fitToScreen,
      cameraControls,

      mousePosition: readonly(mousePosition),
      isMouseOverCanvas: readonly(isMouseOverCanvas),

      multicolorInfo: readonly(multicolorInfo),

      testKeyboard,
      forceEnableKeyboard,
      debugKeyboardState
    };
  }
}).mount('#app'));

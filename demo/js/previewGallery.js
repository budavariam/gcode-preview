// PreviewGallery.js - FIXED VERSION
import { ref, watch, computed, nextTick, getCurrentInstance, onMounted } from 'vue';
import { loadGCodeFromServer, createPreviewInstance, renderGCodePreview } from './gcode-utils.js';

export function createPreviewGallery() {
    return {
        name: 'PreviewGallery',
        template: `
      <div v-if="visible" class="gallery-modal-overlay" @click.self="$emit('close')">
        <div class="gallery-modal-content" @click.stop>
          <h3>Gallery ({{ totalItems }} items) - Showing {{ renderedItems.length }} visible</h3>
          <button class="gallery-close" @click="$emit('close')">×</button>
          
          <div class="gallery-scroll-container" ref="scrollContainer" @scroll="onScroll">
            <div class="gallery-scroll-spacer" :style="{ height: totalHeight + 'px' }">
              <div 
                v-for="(item, index) in renderedItems" 
                :key="item.key"
                class="gallery-virtual-item" 
                :style="getItemStyle(index)"
                @click="selectItem(item)"
                :class="{ 'selected': selectedItemId === item.key }"
              >
                <div class="gallery-preview">
                  <canvas 
                    :ref="'canvas-' + index"
                    class="gallery-canvas"
                    :width="160" 
                    :height="120"
                  ></canvas>
                  <div v-if="!isLoaded(getAbsoluteIndex(index))" class="gallery-loading">
                    {{ getLoadingText(getAbsoluteIndex(index)) }}
                  </div>
                </div>
                <div class="gallery-info">
                  <div class="gallery-title">{{ getFullName(item) }}</div>
                  <div class="gallery-desc">Click to load G-code</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `,
        props: {
            visible: Boolean,
            dynamicPresets: Object,
        },
        emits: ['close', 'select'],
        setup(props, { emit }) {
            const instance = getCurrentInstance();
            const loadedCanvases = ref({});
            const currentlyLoading = ref(-1);
            const previewInstances = ref({});

            // Selected item tracking for URL sync
            const selectedItemId = ref(null);

            // **NEW**: Flag to prevent auto-close during URL initialization
            const isInitializing = ref(false);

            // Virtual scrolling state
            const scrollContainer = ref(null);
            const scrollTop = ref(0);
            const itemHeight = 160;
            const visibleCount = 4;
            const buffer = 2;
            const renderedStart = ref(0);
            const renderedEnd = ref(visibleCount + buffer);

            const allItems = computed(() => {
                if (!props.dynamicPresets) return [];
                return Object.entries(props.dynamicPresets).map(([key, preset]) => ({
                    key: key,
                    ...preset
                }));
            });

            const totalItems = computed(() => allItems.value.length);
            const totalHeight = computed(() => totalItems.value * itemHeight);

            const renderedItems = computed(() => {
                const start = renderedStart.value;
                const end = Math.min(renderedEnd.value, allItems.value.length);
                return allItems.value.slice(start, end);
            });

            // URL Query Parameter Management
            function getQueryParam(key) {
                const urlParams = new URLSearchParams(window.location.search);
                return urlParams.get(key);
            }

            function setQueryParam(key, value) {
                const url = new URL(window.location);
                if (value) {
                    url.searchParams.set(key, value);
                } else {
                    url.searchParams.delete(key);
                }
                window.history.replaceState({}, '', url);
            }

            // **FIXED**: Load selected item from URL without closing modal
            function loadSelectedItemFromUrl() {
                const selectedParam = getQueryParam('selectedItem');
                if (selectedParam && allItems.value.length > 0) {
                    const foundItem = allItems.value.find(item => item.key === selectedParam);
                    if (foundItem) {
                        console.log(`[GALLERY] Loading selected item from URL: ${selectedParam}`);
                        selectedItemId.value = selectedParam;

                        // **FIXED**: Set initialization flag and emit without closing
                        isInitializing.value = true;
                        emit('select', selectedParam);
                        // Reset flag after a short delay
                        setTimeout(() => {
                            isInitializing.value = false;
                        }, 100);

                        return true;
                    } else {
                        console.warn(`[GALLERY] Selected item ${selectedParam} not found in presets`);
                        setQueryParam('selectedItem', null);
                    }
                }
                return false;
            }

            // Watch for changes in dynamicPresets and load URL param
            watch(() => props.dynamicPresets, (newPresets) => {
                if (newPresets && Object.keys(newPresets).length > 0) {
                    console.log('[GALLERY] Dynamic presets updated, checking URL params');
                    loadSelectedItemFromUrl();
                }
            }, { immediate: true });

            // Watch for gallery visibility and handle URL params
            watch(() => props.visible, (visible) => {
                if (visible) {
                    console.log('[GALLERY] Modal opened');
                    if (allItems.value.length > 0) {
                        loadSelectedItemFromUrl();
                    }
                } else {
                    console.log('[GALLERY] Modal closed');
                    disposeAllPreviews();
                }
            });

            function getFullName(item) {
                return item.filename || item.title || item.key || 'Unknown File';
            }

            function isLoaded(absoluteIndex) {
                return loadedCanvases.value[absoluteIndex] === true;
            }

            function getAbsoluteIndex(renderedIndex) {
                return renderedStart.value + renderedIndex;
            }

            function getLoadingText(absoluteIndex) {
                if (currentlyLoading.value === absoluteIndex) {
                    return 'Rendering...';
                } else if (currentlyLoading.value > absoluteIndex) {
                    return 'Ready';
                } else {
                    return `Queue ${(absoluteIndex % visibleCount) + 1}`;
                }
            }

            function getItemStyle(renderedIndex) {
                const absoluteIndex = getAbsoluteIndex(renderedIndex);
                return {
                    position: 'absolute',
                    top: (absoluteIndex * itemHeight) + 'px',
                    left: '0',
                    right: '0',
                    height: itemHeight + 'px'
                };
            }

            // **FIXED**: Select item with proper modal behavior
            function selectItem(item) {
                console.log(`[GALLERY] User clicked item: ${item.key}`);

                // Update selected item state
                selectedItemId.value = item.key;

                // Update URL query parameter
                setQueryParam('selectedItem', item.key);

                // Emit select event
                emit('select', item.key);

                // **FIXED**: Always close modal on user click (not during initialization)
                emit('close');
            }

            // Virtual scroll handler
            function onScroll(event) {
                const target = event.target;
                scrollTop.value = target.scrollTop;

                const firstVisible = Math.floor(scrollTop.value / itemHeight);
                const newStart = Math.max(0, firstVisible - buffer);
                const newEnd = Math.min(allItems.value.length, firstVisible + visibleCount + buffer * 2);

                if (newStart !== renderedStart.value || newEnd !== renderedEnd.value) {
                    console.log(`[GALLERY] Virtual scroll update: ${newStart} to ${newEnd}`);

                    disposeOutOfRangePreviews(newStart, newEnd);

                    renderedStart.value = newStart;
                    renderedEnd.value = newEnd;
                }

                const threshold = 200;
                if (target.scrollHeight - (target.scrollTop + target.clientHeight) < threshold) {
                    console.log('[GALLERY] Near bottom - could trigger load more here');
                }
            }

            function disposeOutOfRangePreviews(newStart, newEnd) {
                Object.keys(previewInstances.value).forEach(key => {
                    const absoluteIndex = parseInt(key);
                    if (absoluteIndex < newStart || absoluteIndex >= newEnd) {
                        try {
                            previewInstances.value[key].dispose();
                            delete previewInstances.value[key];
                            delete loadedCanvases.value[key];
                            console.log(`[GALLERY] Disposed preview ${key} (out of range)`);
                        } catch (e) {
                            console.warn(`[GALLERY] Error disposing preview ${key}:`, e);
                        }
                    }
                });
            }

            function disposeAllPreviews() {
                Object.values(previewInstances.value).forEach(preview => {
                    try {
                        preview.dispose();
                    } catch (e) {
                        console.warn('[GALLERY] Error disposing preview:', e);
                    }
                });
                previewInstances.value = {};
                loadedCanvases.value = {};
                currentlyLoading.value = -1;
            }

            async function render3DPreview(item, canvasElement, absoluteIndex) {
                try {
                    console.log(`[GALLERY] [${absoluteIndex}] Rendering preview for: ${getFullName(item)}`);
                    currentlyLoading.value = absoluteIndex;

                    if (!item.file && !item.getFileUrl) {
                        throw new Error(`No file URL for ${getFullName(item)}`);
                    }

                    const fileUrl = typeof item.getFileUrl === 'function' ? item.getFileUrl() : item.file;

                    const preview = createPreviewInstance(canvasElement, item, true);
                    previewInstances.value[absoluteIndex] = preview;

                    const gcodeStream = await loadGCodeFromServer(fileUrl);
                    await renderGCodePreview(preview, gcodeStream, 100);

                    loadedCanvases.value[absoluteIndex] = true;
                    console.log(`[GALLERY] [${absoluteIndex}] ✅ Preview rendered for: ${getFullName(item)}`);

                } catch (error) {
                    console.error(`[GALLERY] [${absoluteIndex}] Error:`, error);

                    const ctx = canvasElement.getContext('2d');
                    if (ctx) {
                        ctx.fillStyle = '#141414';
                        ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
                        ctx.fillStyle = '#95dfa1';
                        ctx.font = '12px monospace';
                        ctx.textAlign = 'center';
                        ctx.fillText('Preview Error', canvasElement.width / 2, canvasElement.height / 2);
                    }

                    loadedCanvases.value[absoluteIndex] = true;
                }
            }

            async function loadVisiblePreviews(items) {
                console.log(`[GALLERY] Loading ${items.length} visible previews`);

                for (let renderedIndex = 0; renderedIndex < items.length; renderedIndex++) {
                    const item = items[renderedIndex];
                    const absoluteIndex = getAbsoluteIndex(renderedIndex);

                    if (loadedCanvases.value[absoluteIndex]) continue;

                    await nextTick();

                    const canvasRef = instance.refs[`canvas-${renderedIndex}`];
                    const canvas = Array.isArray(canvasRef) ? canvasRef[0] : canvasRef;

                    if (!canvas) {
                        console.warn(`[GALLERY] Canvas not found for rendered index ${renderedIndex}`);
                        continue;
                    }

                    await render3DPreview(item, canvas, absoluteIndex);
                    await new Promise(resolve => setTimeout(resolve, 800));
                }

                currentlyLoading.value = -1;
                console.log(`[GALLERY] ✅ All visible previews loaded`);
            }

            watch(renderedItems, async (newItems) => {
                if (!newItems.length) return;
                await nextTick();
                await loadVisiblePreviews(newItems);
            });

            onMounted(() => {
                if (props.visible && allItems.value.length > 0) {
                    loadSelectedItemFromUrl();
                }
            });

            watch(() => props.visible, (visible) => {
                if (visible) {
                    renderedStart.value = 0;
                    renderedEnd.value = visibleCount + buffer;
                    scrollTop.value = 0;
                    nextTick(() => {
                        if (scrollContainer.value) {
                            scrollContainer.value.scrollTop = 0;
                        }
                    });
                } else {
                    disposeAllPreviews();
                    console.log('[GALLERY] Modal closed, all previews disposed');
                }
            });

            return {
                scrollContainer,
                renderedItems,
                totalItems,
                totalHeight,
                getFullName,
                isLoaded,
                getAbsoluteIndex,
                getLoadingText,
                getItemStyle,
                selectItem,
                onScroll,
                selectedItemId
            };
        }
    };
}

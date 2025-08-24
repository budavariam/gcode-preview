// PreviewGallery.js - VIRTUALIZED INFINITE SCROLL
import { ref, watch, computed, nextTick, getCurrentInstance } from 'vue';
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

            // Virtual scrolling state
            const scrollContainer = ref(null);
            const scrollTop = ref(0);
            const itemHeight = 160; // Height per item including margin
            const visibleCount = 4; // Show 4 items at once
            const buffer = 2; // Extra items to render above/below
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

            // Only render items in current viewport + buffer
            const renderedItems = computed(() => {
                const start = renderedStart.value;
                const end = Math.min(renderedEnd.value, allItems.value.length);
                return allItems.value.slice(start, end);
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

            function selectItem(item) {
                console.log('[GALLERY] Selecting item:', item.key);
                emit('select', item.key);
            }

            // Virtual scroll handler
            function onScroll(event) {
                const target = event.target;
                scrollTop.value = target.scrollTop;

                // Calculate which items should be visible
                const firstVisible = Math.floor(scrollTop.value / itemHeight);
                const newStart = Math.max(0, firstVisible - buffer);
                const newEnd = Math.min(allItems.value.length, firstVisible + visibleCount + buffer * 2);

                // Only update if range actually changed
                if (newStart !== renderedStart.value || newEnd !== renderedEnd.value) {
                    console.log(`[GALLERY] Virtual scroll update: ${newStart} to ${newEnd}`);

                    // Dispose old previews that are going out of view
                    disposeOutOfRangePreviews(newStart, newEnd);

                    renderedStart.value = newStart;
                    renderedEnd.value = newEnd;
                }

                // Infinite scroll - load more when near bottom
                const threshold = 200; // pixels from bottom
                if (target.scrollHeight - (target.scrollTop + target.clientHeight) < threshold) {
                    console.log('[GALLERY] Near bottom - could trigger load more here');
                    // Your load more logic would go here
                }
            }

            // Dispose previews that are no longer in rendered range
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

            // Dispose all current previews
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

            // Render single 3D preview
            async function render3DPreview(item, canvasElement, absoluteIndex) {
                try {
                    console.log(`[GALLERY] [${absoluteIndex}] Rendering preview for: ${getFullName(item)}`);
                    currentlyLoading.value = absoluteIndex;

                    if (!item.file && !item.getFileUrl) {
                        throw new Error(`No file URL for ${getFullName(item)}`);
                    }

                    const fileUrl = typeof item.getFileUrl === 'function' ? item.getFileUrl() : item.file;

                    // Use shared preview creation function
                    const preview = createPreviewInstance(canvasElement, item, true); // true = gallery mode
                    previewInstances.value[absoluteIndex] = preview;

                    // Use shared G-code loading function
                    const gcodeStream = await loadGCodeFromServer(fileUrl);

                    // Use shared rendering function
                    await renderGCodePreview(preview, gcodeStream, 100);

                    loadedCanvases.value[absoluteIndex] = true;
                    console.log(`[GALLERY] [${absoluteIndex}] ✅ Preview rendered for: ${getFullName(item)}`);

                } catch (error) {
                    console.error(`[GALLERY] [${absoluteIndex}] Error:`, error);

                    // Fallback rendering
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

            // Load visible previews sequentially
            async function loadVisiblePreviews(items) {
                console.log(`[GALLERY] Loading ${items.length} visible previews`);

                for (let renderedIndex = 0; renderedIndex < items.length; renderedIndex++) {
                    const item = items[renderedIndex];
                    const absoluteIndex = getAbsoluteIndex(renderedIndex);

                    // Skip if already loaded
                    if (loadedCanvases.value[absoluteIndex]) continue;

                    await nextTick();

                    const canvasRef = instance.refs[`canvas-${renderedIndex}`];
                    const canvas = Array.isArray(canvasRef) ? canvasRef[0] : canvasRef;

                    if (!canvas) {
                        console.warn(`[GALLERY] Canvas not found for rendered index ${renderedIndex}`);
                        continue;
                    }

                    await render3DPreview(item, canvas, absoluteIndex);
                    await new Promise(resolve => setTimeout(resolve, 800)); // Delay between renders
                }

                currentlyLoading.value = -1;
                console.log(`[GALLERY] ✅ All visible previews loaded`);
            }

            // Load previews when rendered items change
            watch(renderedItems, async (newItems) => {
                if (!newItems.length) return;
                await nextTick();
                await loadVisiblePreviews(newItems);
            });

            // Reset when modal opens/closes
            watch(() => props.visible, (visible) => {
                if (visible) {
                    // Reset to top when opening
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
                onScroll
            };
        }
    };
}

// PreviewGallery.js - USING SHARED WEBGL CONTEXT
import { ref, watch, computed, nextTick, getCurrentInstance } from 'vue';
import {
    loadGCodeFromServer,
    createPreviewInstance,
    renderGCodePreview,
    disposeGalleryPreview,
    disposeAllGalleryPreviews,
    getWebGLStatus
} from './gcode-utils.js';

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
            const itemHeight = 160;
            const visibleCount = 4; // Can be higher now with shared context
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
                } else if (loadedCanvases.value[absoluteIndex] === true) {
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
            }

            function disposeOutOfRangePreviews(newStart, newEnd) {
                const keysToDispose = [];

                Object.keys(previewInstances.value).forEach(key => {
                    const absoluteIndex = parseInt(key);
                    if (absoluteIndex < newStart || absoluteIndex >= newEnd) {
                        keysToDispose.push(key);
                    }
                });

                console.log(`[GALLERY] 🗑️  Disposing ${keysToDispose.length} out-of-range previews`);

                keysToDispose.forEach(key => {
                    const preview = previewInstances.value[key];

                    if (disposeGalleryPreview(preview)) {
                        delete previewInstances.value[key];
                        delete loadedCanvases.value[key];
                    }
                });
            }

            function disposeAllPreviews() {
                console.log('[GALLERY] 🧹 Disposing all gallery previews (shared context)');

                disposeAllGalleryPreviews();

                previewInstances.value = {};
                loadedCanvases.value = {};
                currentlyLoading.value = -1;

                const webglStatus = getWebGLStatus();
                console.log('[GALLERY] 📊 WebGL Status after disposal:', webglStatus);
            }

            async function render3DPreview(item, canvasElement, absoluteIndex) {
                try {
                    console.log(`[GALLERY] [${absoluteIndex}] Rendering preview (shared context)`);
                    currentlyLoading.value = absoluteIndex;

                    if (!item.file && !item.getFileUrl) {
                        throw new Error(`No file URL for ${getFullName(item)}`);
                    }

                    const fileUrl = typeof item.getFileUrl === 'function' ? item.getFileUrl() : item.file;

                    // Create gallery preview using shared context
                    const preview = createPreviewInstance(canvasElement, item, true);
                    previewInstances.value[absoluteIndex] = preview;

                    const gcodeStream = await loadGCodeFromServer(fileUrl);
                    await renderGCodePreview(preview, gcodeStream, 100);

                    loadedCanvases.value[absoluteIndex] = true;
                    console.log(`[GALLERY] [${absoluteIndex}] ✅ Shared context preview rendered`);

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

            async function loadVisiblePreviews(items) {
                console.log(`[GALLERY] Loading ${items.length} visible previews (shared context)`);

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
                    await new Promise(resolve => setTimeout(resolve, 200)); // Faster with shared context
                }

                currentlyLoading.value = -1;
                console.log(`[GALLERY] ✅ All visible previews loaded (shared context)`);
            }

            watch(renderedItems, async (newItems) => {
                if (!newItems.length) return;
                await nextTick();
                await loadVisiblePreviews(newItems);
            });

            watch(() => props.visible, (visible) => {
                if (visible) {
                    console.log('[GALLERY] 🎨 Opening gallery (shared WebGL context)');

                    renderedStart.value = 0;
                    renderedEnd.value = visibleCount + buffer;
                    scrollTop.value = 0;

                    nextTick(() => {
                        if (scrollContainer.value) {
                            scrollContainer.value.scrollTop = 0;
                        }
                    });
                } else {
                    console.log('[GALLERY] 🚪 Closing gallery (shared context preserved for reuse)');
                    disposeAllPreviews();
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

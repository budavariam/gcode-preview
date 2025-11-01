import { ref, computed, watch, onMounted } from 'vue';

export default {
  name: 'PathProgressSlider',
  props: {
    preview: {
      type: Object,
      default: null
    }
  },
  emits: ['progress-change'],
  setup(props, { emit }) {
    const currentPosition = ref(0);
    const totalPositions = ref(0);
    const pathPoints = ref([]);
    const isPlaying = ref(false);
    const animationSpeed = ref(1);
    let animationFrame = null;

    const progressPercentage = computed(() => {
      if (totalPositions.value === 0) return 0;
      return Math.round((currentPosition.value / (totalPositions.value - 1)) * 100);
    });

    const markerPosition = computed(() => {
      if (totalPositions.value === 0) return '0%';
      return `${(currentPosition.value / (totalPositions.value - 1)) * 100}%`;
    });

    const extractPathPoints = () => {
      if (!props.preview) {
        console.warn('[TRAVEL-SLIDER] Preview not available');
        return;
      }

      if (!props.preview.job) {
        console.warn('[TRAVEL-SLIDER] Preview.job not available');
        return;
      }

      try {
        const job = props.preview.job;
        const points = [];

        const travelPaths = job.travels;

        if (travelPaths && Array.isArray(travelPaths)) {
          for (const path of travelPaths) {
            if (path.vertices && Array.isArray(path.vertices)) {
              for (let i = 0; i < path.vertices.length; i += 3) {
                points.push({
                  x: path.vertices[i],
                  y: path.vertices[i + 1],
                  z: path.vertices[i + 2],
                  type: 'travel'
                });
              }
            }
          }
        }

        pathPoints.value = points;
        totalPositions.value = points.length;
        currentPosition.value = 0;

        console.log(`[TRAVEL-SLIDER] Extracted ${points.length} travel path points`);
      } catch (error) {
        console.error('[TRAVEL-SLIDER] Error extracting path points:', error);
      }
    };

    const handleSliderChange = () => {
      emit('progress-change', {
        position: currentPosition.value,
        total: totalPositions.value,
        percentage: progressPercentage.value,
        point: pathPoints.value[currentPosition.value]
      });
    };

    const playAnimation = () => {
      if (isPlaying.value) return;
      isPlaying.value = true;

      const animate = () => {
        if (!isPlaying.value) return;

        currentPosition.value += animationSpeed.value;

        if (currentPosition.value >= totalPositions.value - 1) {
          currentPosition.value = totalPositions.value - 1;
          pauseAnimation();
          return;
        }

        handleSliderChange();
        animationFrame = requestAnimationFrame(animate);
      };

      animationFrame = requestAnimationFrame(animate);
    };

    const pauseAnimation = () => {
      isPlaying.value = false;
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };

    const resetProgress = () => {
      pauseAnimation();
      currentPosition.value = 0;
      handleSliderChange();
    };

    // FIX: Added lifecycle hook
    onMounted(() => {
      console.log('[TRAVEL-SLIDER] Component mounted');
      if (props.preview && props.preview.job) {
        extractPathPoints();
      }
    });

    // FIX: Added watcher to detect when preview changes/loads
    watch(
      () => props.preview,
      (newPreview) => {
        console.log('[TRAVEL-SLIDER] Preview prop changed');
        if (newPreview && newPreview.job) {
          // Small delay to ensure job is fully loaded
          setTimeout(extractPathPoints, 300);
        }
      },
      { deep: false }
    );

    // FIX: Also watch for job changes specifically
    watch(
      () => props.preview?.job,
      (newJob) => {
        console.log('[TRAVEL-SLIDER] Job data changed');
        if (newJob) {
          extractPathPoints();
        }
      },
      { deep: false }
    );

    return {
      currentPosition,
      totalPositions,
      progressPercentage,
      markerPosition,
      isPlaying,
      animationSpeed,
      handleSliderChange,
      playAnimation,
      pauseAnimation,
      resetProgress,
      extractPathPoints
    };
  },
  template: `
    <div class="path-progress-slider">
      <div class="slider-header">
        <label>Travel Path Progress</label>
        <span class="progress-info">
          {{ currentPosition + 1 }} / {{ totalPositions }} 
          ({{ progressPercentage }}%)
        </span>
      </div>
      <div class="slider-container">
        <input
          type="range"
          min="0"
          :max="totalPositions - 1"
          v-model.number="currentPosition"
          @input="handleSliderChange"
          class="progress-slider"
          :disabled="totalPositions === 0"
        />
      </div>
      <div class="slider-footer">
        <button @click="playAnimation" :disabled="isPlaying || totalPositions === 0">
          {{ isPlaying ? 'Playing...' : 'Play' }}
        </button>
        <button @click="pauseAnimation" :disabled="!isPlaying">
          Pause
        </button>
        <button @click="resetProgress" :disabled="totalPositions === 0">
          Reset
        </button>
        <label class="speed-control">
          Speed: 
          <input 
            type="number" 
            v-model.number="animationSpeed" 
            min="1" 
            max="100"
            step="1"
          /> steps/frame
        </label>
      </div>
    </div>
  `
};

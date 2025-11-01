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
    const travelSegmentBoundaries = ref([]);
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
        const boundaries = [];
        let pointIndex = 0;

        const travelPaths = job.travels;

        if (travelPaths && Array.isArray(travelPaths)) {
          for (const path of travelPaths) {
            if (path.vertices && Array.isArray(path.vertices)) {
              const segmentStart = pointIndex;

              for (let i = 0; i < path.vertices.length; i += 3) {
                points.push({
                  x: path.vertices[i],
                  y: path.vertices[i + 1],
                  z: path.vertices[i + 2],
                  type: 'travel'
                });
                pointIndex++;
              }

              const segmentEnd = pointIndex - 1;
              boundaries.push({ start: segmentStart, end: segmentEnd });
            }
          }
        }

        pathPoints.value = points;
        travelSegmentBoundaries.value = boundaries;
        totalPositions.value = points.length;
        currentPosition.value = 0;

        console.log(`[TRAVEL-SLIDER] Extracted ${points.length} travel path points in ${boundaries.length} segments`);
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

    const playCurrentSegment = () => {
      if (isPlaying.value) return;
      if (pathPoints.value.length === 0) {
        console.warn('[TRAVEL-SLIDER] No path points available');
        return;
      }

      // Find where Z changes from current position onwards
      const currentZ = pathPoints.value[currentPosition.value]?.z;
      let segmentEnd = currentPosition.value;

      // Scan forward until Z value changes
      for (let i = currentPosition.value + 1; i < pathPoints.value.length; i++) {
        const point = pathPoints.value[i];

        // If Z changes significantly (pen up/down), stop here
        if (Math.abs(point.z - currentZ) > 0.1) {
          segmentEnd = i - 1;
          break;
        }

        // Otherwise, continue to the next point
        segmentEnd = i;
      }

      // If we reached the end without finding a Z change, use the last point
      if (segmentEnd === currentPosition.value) {
        segmentEnd = pathPoints.value.length - 1;
        console.warn('[TRAVEL-SLIDER] No Z change found, playing to end');
      }

      console.log(`[TRAVEL-SLIDER] Playing segment from ${currentPosition.value} to ${segmentEnd} (Z: ${currentZ})`);

      isPlaying.value = true;

      const animate = () => {
        if (!isPlaying.value) return;

        currentPosition.value += animationSpeed.value;

        if (currentPosition.value >= segmentEnd) {
          currentPosition.value = segmentEnd;
          pauseAnimation();
          handleSliderChange();
          console.log('[TRAVEL-SLIDER] Reached end of segment (Z change detected)');
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

    const nextFrame = () => {
      pauseAnimation();
      if (currentPosition.value < totalPositions.value - 1) {
        currentPosition.value += 1;
        handleSliderChange();
      }
    };

    const prevFrame = () => {
      pauseAnimation();
      if (currentPosition.value > 0) {
        currentPosition.value -= 1;
        handleSliderChange();
      }
    };

    const jumpForward = () => {
      pauseAnimation();
      currentPosition.value = Math.min(
        currentPosition.value + 10,
        totalPositions.value - 1
      );
      handleSliderChange();
    };

    const jumpBackward = () => {
      pauseAnimation();
      currentPosition.value = Math.max(currentPosition.value - 10, 0);
      handleSliderChange();
    };

    const jumpToStart = () => {
      pauseAnimation();
      currentPosition.value = 0;
      handleSliderChange();
    };

    const jumpToEnd = () => {
      pauseAnimation();
      currentPosition.value = totalPositions.value - 1;
      handleSliderChange();
    };

    const stop = () => {
      pauseAnimation();
    };

    onMounted(() => {
      console.log('[TRAVEL-SLIDER] Component mounted');
      if (props.preview && props.preview.job) {
        extractPathPoints();
      }
    });

    watch(
      () => props.preview,
      (newPreview) => {
        console.log('[TRAVEL-SLIDER] Preview prop changed');
        if (newPreview && newPreview.job) {
          setTimeout(extractPathPoints, 300);
        }
      },
      { deep: false }
    );

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
      playCurrentSegment,
      pauseAnimation,
      resetProgress,
      nextFrame,
      prevFrame,
      jumpForward,
      jumpBackward,
      jumpToStart,
      jumpToEnd,
      stop,
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
        <button @click="playAnimation" :disabled="isPlaying || totalPositions === 0" class="slider-btn">
          {{ isPlaying ? 'Playing...' : 'Play' }}
        </button>
        <button @click="playCurrentSegment" :disabled="isPlaying || totalPositions === 0" class="slider-btn" title="Play until next travel">
          Play Segment
        </button>
        <button @click="pauseAnimation" :disabled="!isPlaying" class="slider-btn">
          Pause
        </button>
        <button @click="stop" :disabled="totalPositions === 0" class="slider-btn">
          Stop
        </button>
        <button @click="resetProgress" :disabled="totalPositions === 0" class="slider-btn">
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
      <div class="stepper-controls">
        <button @click="jumpToStart" :disabled="totalPositions === 0" class="slider-btn" title="Jump to start">
          ⏮ Start
        </button>
        <button @click="jumpBackward" :disabled="totalPositions === 0" class="slider-btn" title="Jump 10 frames backward">
          ⏪ -10x
        </button>
        <button @click="prevFrame" :disabled="totalPositions === 0" class="slider-btn" title="Previous frame">
          ◀ Prev
        </button>
        <button @click="nextFrame" :disabled="totalPositions === 0" class="slider-btn" title="Next frame">
          Next ▶
        </button>
        <button @click="jumpForward" :disabled="totalPositions === 0" class="slider-btn" title="Jump 10 frames forward">
          +10x ⏩
        </button>
        <button @click="jumpToEnd" :disabled="totalPositions === 0" class="slider-btn" title="Jump to end">
          End ⏭
        </button>
      </div>
      <style scoped>
        .path-progress-slider {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px;
          background: rgba(0, 0, 0, 0.1);
          border-radius: 4px;
        }

        .slider-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          font-weight: 500;
        }

        .progress-info {
          color: rgba(255, 255, 255, 0.7);
          font-size: 11px;
        }

        .slider-container {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .progress-slider {
          flex: 1;
          height: 6px;
          cursor: pointer;
          accent-color: #00bfff;
        }

        .slider-footer {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }

        .stepper-controls {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }

        .slider-btn {
          padding: 6px 12px;
          font-size: 11px;
          font-weight: 500;
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.1);
          color: rgba(255, 255, 255, 0.9);
          cursor: pointer;
          transition: all 0.15s ease;
          white-space: nowrap;
        }

        .slider-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.2);
          border-color: rgba(255, 255, 255, 0.5);
          box-shadow: 0 0 8px rgba(0, 191, 255, 0.3);
        }

        .slider-btn:active:not(:disabled) {
          background: rgba(255, 255, 255, 0.15);
          transform: scale(0.98);
        }

        .slider-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .speed-control {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          white-space: nowrap;
        }

        .speed-control input {
          width: 45px;
          padding: 4px 6px;
          font-size: 11px;
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 3px;
          background: rgba(0, 0, 0, 0.2);
          color: rgba(255, 255, 255, 0.9);
        }
      </style>
    </div>
  `
};

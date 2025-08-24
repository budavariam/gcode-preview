// gcode-utils.js - FIXED SHARED WEBGL CONTEXT WITH PROPER RENDERING
import * as THREE from 'three';

// Shared WebGL context for gallery
let sharedGalleryRenderer = null;
let sharedGalleryCanvas = null;
let galleryPreviews = new Map();

// Main canvas instance (separate)
let mainCanvasInstance = null;

// Fresh URL helper
export function getFreshUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_t=${Date.now()}&_r=${Math.random().toString(36).slice(2)}`;
}

// Parse build volume from G-code comments
export function parseBuildVolumeFromGCode(gcodeText) {
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
            z: Math.ceil(z * padding)
        };
    }
    return null;
}

// Create G-code stream transformer
export function createGCodeStream(response) {
    let detectedBuildVolume = null;

    return response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
            transform(chunk, controller) {
                let processedChunk = chunk.replace(/^N\d+\s+/gm, "");

                if (!detectedBuildVolume) {
                    const lines = processedChunk.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        const boundMatch = trimmed.match(/;\s*(min_|max_)([xyz])\s*=\s*([-\d.]+)/i);
                        if (boundMatch) {
                            detectedBuildVolume = parseBuildVolumeFromGCode(processedChunk);
                            break;
                        }
                    }
                }

                controller.enqueue(processedChunk);
            }
        }));
}

// Shared G-code loading function
export async function loadGCodeFromServer(filename) {
    const finalUrl = filename.includes('localhost:2727') ? getFreshUrl(filename) : filename;
    const response = await fetch(finalUrl, { cache: 'no-store' });

    if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return createGCodeStream(response);
}

// Initialize shared gallery WebGL context
export function initializeSharedGalleryContext() {
    if (sharedGalleryRenderer) {
        console.log('[GCODE-UTILS] Shared gallery context already exists');
        return sharedGalleryRenderer;
    }

    // Create a larger offscreen canvas
    sharedGalleryCanvas = document.createElement('canvas');
    sharedGalleryCanvas.width = 1600; // 10 columns of 160px
    sharedGalleryCanvas.height = 1200; // 10 rows of 120px
    sharedGalleryCanvas.style.display = 'none';
    document.body.appendChild(sharedGalleryCanvas);

    // Create shared WebGL renderer
    sharedGalleryRenderer = new THREE.WebGLRenderer({
        canvas: sharedGalleryCanvas,
        antialias: true,
        preserveDrawingBuffer: true
    });

    sharedGalleryRenderer.setSize(1600, 1200);
    sharedGalleryRenderer.setClearColor(0x141414); // Dark background
    sharedGalleryRenderer.setScissorTest(true);

    console.log('[GCODE-UTILS] ✅ Shared gallery WebGL context initialized (1600x1200)');
    return sharedGalleryRenderer;
}

// **FIXED**: Create individual gallery preview with proper viewport allocation
export function createGalleryPreview(canvasElement, presetOptions, previewId) {
    if (!sharedGalleryRenderer) {
        initializeSharedGalleryContext();
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 160 / 120, 0.1, 1000);

    // Set up camera
    camera.position.set(50, 50, 100);
    camera.lookAt(0, 0, 0);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 0.8);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(100, 100, 50);
    scene.add(directionalLight);

    // **FIXED**: Allocate viewport based on preview count
    const previewCount = galleryPreviews.size;
    const viewportX = (previewCount % 10) * 160; // 10 columns
    const viewportY = Math.floor(previewCount / 10) * 120; // Rows of 120px

    const preview = {
        id: previewId,
        scene,
        camera,
        renderer: sharedGalleryRenderer,
        canvas: canvasElement,
        targetCanvas: canvasElement,
        viewportX,
        viewportY,
        viewportWidth: 160,
        viewportHeight: 120,
        isGallery: true,
        hasGeometry: false,

        // **FIXED**: Process G-code with better debugging
        async processGCode(gCodeContent) {
            console.log(`[GALLERY-PREVIEW] Processing G-code for ${this.id} (${gCodeContent.length} chars)`);

            // Clear existing geometry
            const existingGcode = scene.getObjectByName('gcode-geometry');
            if (existingGcode) {
                scene.remove(existingGcode);
                if (existingGcode.geometry) existingGcode.geometry.dispose();
                if (existingGcode.material) existingGcode.material.dispose();
            }

            const geometry = this.parseGCodeToGeometry(gCodeContent);
            if (!geometry) {
                console.warn(`[GALLERY-PREVIEW] No geometry created for ${this.id}`);
                return false;
            }

            const material = new THREE.LineBasicMaterial({
                color: 0x95dfa1,
                linewidth: 2
            });

            const gcodeObject = new THREE.LineSegments(geometry, material);
            gcodeObject.name = 'gcode-geometry';
            scene.add(gcodeObject);

            console.log(`[GALLERY-PREVIEW] Added geometry to scene for ${this.id}:`, {
                vertices: geometry.attributes.position.count,
                boundingBox: new THREE.Box3().setFromObject(gcodeObject)
            });

            this.fitCameraToObject(gcodeObject);
            this.hasGeometry = true;
            return true;
        },

        // **FIXED**: Better G-code parsing with more debug info
        parseGCodeToGeometry(gCodeContent) {
            const lines = gCodeContent.split('\n');
            const vertices = [];
            let currentX = 0, currentY = 0, currentZ = 0;
            let lastE = null;
            let extrusionMoves = 0;
            let travelMoves = 0;

            console.log(`[GALLERY-PREVIEW] Parsing ${lines.length} G-code lines`);

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('M')) continue;

                if (trimmed.startsWith('G1') || trimmed.startsWith('G0')) {
                    const newX = this.extractCoordinate(trimmed, 'X', currentX);
                    const newY = this.extractCoordinate(trimmed, 'Y', currentY);
                    const newZ = this.extractCoordinate(trimmed, 'Z', currentZ);

                    const eMatch = trimmed.match(/E([+-]?\d*\.?\d+)/);
                    const currentE = eMatch ? parseFloat(eMatch[1]) : null;

                    const hasMovement = (newX !== currentX || newY !== currentY || newZ !== currentZ);

                    if (hasMovement) {
                        const isExtrusion = currentE !== null && (lastE === null || currentE > lastE);

                        if (isExtrusion || trimmed.startsWith('G0')) {
                            vertices.push(currentX, currentY, currentZ);
                            vertices.push(newX, newY, newZ);

                            if (isExtrusion) extrusionMoves++;
                            else travelMoves++;
                        }
                    }

                    currentX = newX;
                    currentY = newY;
                    currentZ = newZ;
                    if (currentE !== null) lastE = currentE;
                }
            }

            console.log(`[GALLERY-PREVIEW] G-code parsing results:`, {
                totalLines: lines.length,
                extrusionMoves,
                travelMoves,
                totalVertices: vertices.length,
                lineSegments: vertices.length / 6
            });

            if (vertices.length === 0) {
                console.warn(`[GALLERY-PREVIEW] No valid geometry found in G-code`);
                return null;
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

            return geometry;
        },

        extractCoordinate(line, axis, defaultValue) {
            const match = line.match(new RegExp(`${axis}([+-]?\\d*\\.?\\d+)`));
            return match ? parseFloat(match[1]) : defaultValue;
        },

        fitCameraToObject(object) {
            const box = new THREE.Box3().setFromObject(object);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());

            const maxDim = Math.max(size.x, size.y, size.z);
            if (maxDim === 0) {
                console.warn(`[GALLERY-PREVIEW] Object has no size, using default camera position`);
                return;
            }

            const fov = camera.fov * (Math.PI / 180);
            const cameraDistance = Math.abs(maxDim / (2 * Math.tan(fov / 2))) * 2.5;

            camera.position.set(
                center.x + cameraDistance * 0.7,
                center.y + cameraDistance * 0.7,
                center.z + cameraDistance
            );
            camera.lookAt(center);
            camera.updateProjectionMatrix();

            console.log(`[GALLERY-PREVIEW] Camera fitted to object:`, {
                center: center,
                size: size,
                cameraPosition: camera.position,
                distance: cameraDistance
            });
        },

        // **FIXED**: Proper rendering with scissor test
        render() {
            if (!this.targetCanvas || !this.hasGeometry) {
                console.warn(`[GALLERY-PREVIEW] Cannot render ${this.id}: canvas=${!!this.targetCanvas}, geometry=${this.hasGeometry}`);
                return;
            }

            console.log(`[GALLERY-PREVIEW] Rendering ${this.id} at viewport (${this.viewportX}, ${this.viewportY}, ${this.viewportWidth}, ${this.viewportHeight})`);

            // **CRITICAL**: Set scissor and viewport for this preview
            const renderer = sharedGalleryRenderer;

            // Enable scissor test
            renderer.setScissorTest(true);

            // Set scissor rectangle (this clips the rendering)
            renderer.setScissor(
                this.viewportX,
                sharedGalleryCanvas.height - this.viewportY - this.viewportHeight, // Flip Y coordinate
                this.viewportWidth,
                this.viewportHeight
            );

            // Set viewport (this sets the rendering area)
            renderer.setViewport(
                this.viewportX,
                sharedGalleryCanvas.height - this.viewportY - this.viewportHeight, // Flip Y coordinate  
                this.viewportWidth,
                this.viewportHeight
            );

            // Clear only this viewport
            renderer.setClearColor(0x141414);
            renderer.clear();

            // Render scene
            renderer.render(scene, camera);

            // **FIXED**: Copy rendered region to target canvas
            this.copyToTargetCanvas();
        },

        // **FIXED**: Proper canvas copying with coordinate flipping
        copyToTargetCanvas() {
            const targetCtx = this.targetCanvas.getContext('2d');
            if (!targetCtx) {
                console.warn(`[GALLERY-PREVIEW] No 2D context for target canvas`);
                return;
            }

            // Clear target canvas
            targetCtx.clearRect(0, 0, this.targetCanvas.width, this.targetCanvas.height);

            // **FIXED**: Copy with proper coordinate system
            try {
                targetCtx.drawImage(
                    sharedGalleryCanvas,
                    this.viewportX, this.viewportY, this.viewportWidth, this.viewportHeight, // Source
                    0, 0, this.targetCanvas.width, this.targetCanvas.height // Destination (scale to fit)
                );

                console.log(`[GALLERY-PREVIEW] Successfully copied viewport to canvas for ${this.id}`);
            } catch (error) {
                console.error(`[GALLERY-PREVIEW] Error copying to canvas for ${this.id}:`, error);

                // **FALLBACK**: Draw a colored rectangle to show something rendered
                targetCtx.fillStyle = '#95dfa1';
                targetCtx.fillRect(0, 0, this.targetCanvas.width, this.targetCanvas.height);
                targetCtx.fillStyle = '#141414';
                targetCtx.font = '12px monospace';
                targetCtx.textAlign = 'center';
                targetCtx.fillText('Copy Error', this.targetCanvas.width / 2, this.targetCanvas.height / 2);
            }
        },

        // Dispose this preview
        dispose() {
            console.log(`[GALLERY-PREVIEW] Disposing preview ${this.id}`);

            // Dispose geometries and materials
            scene.traverse((object) => {
                if (object.geometry) object.geometry.dispose();
                if (object.material) {
                    if (Array.isArray(object.material)) {
                        object.material.forEach(material => material.dispose());
                    } else {
                        object.material.dispose();
                    }
                }
            });

            // Clear scene
            while (scene.children.length > 0) {
                scene.remove(scene.children[0]);
            }

            // Remove from tracking
            galleryPreviews.delete(this.id);
            this.hasGeometry = false;
        }
    };

    // Track this preview
    galleryPreviews.set(previewId, preview);
    console.log(`[GCODE-UTILS] ✅ Gallery preview created: ${previewId} at viewport (${viewportX}, ${viewportY})`);

    return preview;
}

// Main canvas instance (separate WebGL context)
export function createPreviewInstance(canvas, presetOptions, isGallery = false) {
    if (isGallery) {
        // Use shared context for gallery
        const previewId = `gallery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return createGalleryPreview(canvas, presetOptions, previewId);
    }

    // Main canvas - use gcode-preview library as before
    const baseOptions = {
        canvas,
        droppable: true,
        backgroundColor: '#141414',

        extrusionWidth: presetOptions.extrusionWidth || 0.45,
        lineHeight: presetOptions.lineHeight || 0.2,
        extrusionColor: presetOptions.extrusionColor || ['#95dfa1'],
        renderExtrusion: presetOptions.renderExtrusion !== false,
        renderTravel: presetOptions.renderTravel !== false,
        travelColor: presetOptions.travelColor || '#00FFFF',
        lineWidth: presetOptions.lineWidth || 1,
        renderTubes: presetOptions.renderTubes !== false,
        renderStats: true,

        buildVolume: presetOptions.buildVolume || { x: 100, y: 100, z: 10 },
        initialCameraPosition: presetOptions.initialCameraPosition || [50, 50, 150],
        enableControls: true,

        ...presetOptions
    };

    const instance = new GCodePreview.init(baseOptions);
    mainCanvasInstance = instance;

    console.log('[GCODE-UTILS] ✅ Main canvas instance created (separate WebGL context)');
    return instance;
}

// Render G-code preview
export async function renderGCodePreview(preview, gcodeStream, delayMs = 100) {
    if (preview.isGallery) {
        // Gallery preview - convert stream to text
        const reader = gcodeStream.getReader();
        let gCodeContent = '';

        console.log(`[GCODE-UTILS] Reading G-code stream for gallery preview ${preview.id}`);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            gCodeContent += value;
        }

        console.log(`[GCODE-UTILS] Stream read complete: ${gCodeContent.length} characters`);

        const success = await preview.processGCode(gCodeContent);
        if (!success) {
            throw new Error('Failed to process G-code content for gallery preview');
        }

        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        preview.render();

        console.log(`[GCODE-UTILS] ✅ Gallery preview ${preview.id} rendered successfully`);
    } else {
        // Main canvas - use original method
        await preview.processGCode(gcodeStream, { render: false });

        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        preview.render();
        console.log(`[GCODE-UTILS] ✅ Main canvas preview rendered successfully`);
    }
}

// Dispose gallery preview
export function disposeGalleryPreview(preview) {
    if (preview && preview.isGallery) {
        preview.dispose();
        return true;
    }
    return false;
}

// Dispose all gallery previews
export function disposeAllGalleryPreviews() {
    console.log(`[GCODE-UTILS] Disposing ${galleryPreviews.size} gallery previews`);

    galleryPreviews.forEach(preview => {
        preview.dispose();
    });

    galleryPreviews.clear();
    console.log('[GCODE-UTILS] ✅ All gallery previews disposed (main canvas preserved)');
}

// Dispose shared gallery context
export function disposeSharedGalleryContext() {
    if (sharedGalleryRenderer) {
        console.log('[GCODE-UTILS] Disposing shared gallery WebGL context');

        disposeAllGalleryPreviews();

        sharedGalleryRenderer.dispose();

        if (sharedGalleryCanvas && sharedGalleryCanvas.parentNode) {
            sharedGalleryCanvas.parentNode.removeChild(sharedGalleryCanvas);
        }

        sharedGalleryRenderer = null;
        sharedGalleryCanvas = null;

        console.log('[GCODE-UTILS] ✅ Shared gallery context disposed');
    }
}

// Get status
export function getWebGLStatus() {
    return {
        mainCanvas: mainCanvasInstance ? 'EXISTS' : 'NULL',
        sharedGalleryContext: sharedGalleryRenderer ? 'EXISTS' : 'NULL',
        galleryPreviews: galleryPreviews.size,
        totalWebGLContexts: (mainCanvasInstance ? 1 : 0) + (sharedGalleryRenderer ? 1 : 0)
    };
}

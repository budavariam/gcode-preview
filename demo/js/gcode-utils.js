// gcode-utils.js - SHARED GCODE RENDERING UTILITIES
import * as GCodePreview from 'gcode-preview';

// Fresh URL helper (extracted from your main app)
export function getFreshUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_t=${Date.now()}&_r=${Math.random().toString(36).slice(2)}`;
}

// Parse build volume from G-code comments (extracted from your main app)
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

// Create G-code stream transformer (extracted from your main app)
export function createGCodeStream(response) {
    let detectedBuildVolume = null;

    return response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
            transform(chunk, controller) {
                // Remove line numbers (same as main app)
                let processedChunk = chunk.replace(/^N\d+\s+/gm, "");

                // Parse build volume on the fly
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

// Create preview instance with shared options
export function createPreviewInstance(canvas, presetOptions, isGallery = false) {
    const baseOptions = {
        canvas,
        droppable: !isGallery, // No drag-drop in gallery
        backgroundColor: '#141414', // Your app's dark background

        // Default rendering options (same as your app)
        extrusionWidth: presetOptions.extrusionWidth || 0.45,
        lineHeight: presetOptions.lineHeight || 0.2,
        extrusionColor: presetOptions.extrusionColor || ['#95dfa1'],
        renderExtrusion: presetOptions.renderExtrusion !== false,
        renderTravel: presetOptions.renderTravel !== false,
        travelColor: presetOptions.travelColor || '#00FFFF',
        lineWidth: isGallery ? 1 : (presetOptions.lineWidth || 1),
        renderTubes: !isGallery && (presetOptions.renderTubes !== false),
        renderStats: !isGallery, // No stats in gallery

        buildVolume: presetOptions.buildVolume || { x: 100, y: 100, z: 10 },
        initialCameraPosition: presetOptions.initialCameraPosition || [50, 50, 150],
        enableControls: !isGallery, // No interaction in gallery

        // Apply any other preset-specific options
        ...presetOptions
    };

    return new GCodePreview.init(baseOptions);
}

// Shared render function
export async function renderGCodePreview(preview, gcodeStream, delayMs = 100) {
    await preview.processGCode(gcodeStream, { render: false });

    if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    preview.render();
}

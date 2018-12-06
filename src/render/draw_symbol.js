// @flow

import drawCollisionDebug from './draw_collision_debug';

import SegmentVector from '../data/segment';
import pixelsToTileUnits from '../source/pixels_to_tile_units';
import * as symbolProjection from '../symbol/projection';
import * as symbolSize from '../symbol/symbol_size';
import { mat4 } from 'gl-matrix';
const identityMat4 = mat4.identity(new Float32Array(16));
import properties from '../style/style_layer/symbol_style_layer_properties';
const symbolLayoutProperties = properties.layout;
import StencilMode from '../gl/stencil_mode';
import DepthMode from '../gl/depth_mode';
import CullFaceMode from '../gl/cull_face_mode';
import {
    symbolIconUniformValues,
    symbolSDFUniformValues
} from './program/symbol_program';

import type Painter from './painter';
import type SourceCache from '../source/source_cache';
import type SymbolStyleLayer from '../style/style_layer/symbol_style_layer';
import type SymbolBucket, {SymbolBuffers} from '../data/bucket/symbol_bucket';
import type Texture from '../render/texture';
import type {OverscaledTileID} from '../source/tile_id';
import type {UniformValues} from './uniform_binding';
import type {SymbolSDFUniformsType} from '../render/program/symbol_program';

export default drawSymbols;

type SymbolTileRenderState = {
    buffers: SymbolBuffers,
    program: any,
    depthMode: DepthMode,
    uniformValues: any,
    atlasTexture: Texture,
    atlasInterpolation: any,
    isSDF: boolean,
    hasHalo: boolean
};

function drawSymbols(painter: Painter, sourceCache: SourceCache, layer: SymbolStyleLayer, coords: Array<OverscaledTileID>) {
    if (painter.renderPass !== 'translucent') return;

    // Disable the stencil test so that labels aren't clipped to tile boundaries.
    const stencilMode = StencilMode.disabled;
    const colorMode = painter.colorModeForRenderPass();

    const sortFeaturesByKey = layer.layout.get('symbol-sort-key').constantOr(1) !== undefined;

    if (layer.paint.get('icon-opacity').constantOr(1) !== 0) {
        const tileRenderState = sortFeaturesByKey ? [] : undefined;
        drawLayerSymbols(painter, sourceCache, layer, coords, false,
            layer.paint.get('icon-translate'),
            layer.paint.get('icon-translate-anchor'),
            layer.layout.get('icon-rotation-alignment'),
            layer.layout.get('icon-pitch-alignment'),
            layer.layout.get('icon-keep-upright'),
            stencilMode, colorMode, tileRenderState
        );
        if (sortFeaturesByKey) {
            drawSymbolsSorted(painter, ((tileRenderState: any): Array<SymbolTileRenderState>), layer, colorMode, stencilMode);
        }
    }

    if (layer.paint.get('text-opacity').constantOr(1) !== 0) {
        const tileRenderState = sortFeaturesByKey ? [] : undefined;
        drawLayerSymbols(painter, sourceCache, layer, coords, true,
            layer.paint.get('text-translate'),
            layer.paint.get('text-translate-anchor'),
            layer.layout.get('text-rotation-alignment'),
            layer.layout.get('text-pitch-alignment'),
            layer.layout.get('text-keep-upright'),
            stencilMode, colorMode, tileRenderState
        );
        if (sortFeaturesByKey) {
            drawSymbolsSorted(painter, ((tileRenderState: any): Array<SymbolTileRenderState>), layer, colorMode, stencilMode);
        }
    }

    if (sourceCache.map.showCollisionBoxes) {
        drawCollisionDebug(painter, sourceCache, layer, coords);
    }
}

function drawLayerSymbols(painter, sourceCache, layer, coords, isText, translate, translateAnchor,
    rotationAlignment, pitchAlignment, keepUpright, stencilMode, colorMode, tileRenderState) {

    const context = painter.context;
    const gl = context.gl;
    const tr = painter.transform;

    const sortByFeature = Boolean(tileRenderState);
    const rotateWithMap = rotationAlignment === 'map';
    const pitchWithMap = pitchAlignment === 'map';
    const alongLine = rotateWithMap && layer.layout.get('symbol-placement') !== 'point';
    // Line label rotation happens in `updateLineLabels`
    // Pitched point labels are automatically rotated by the labelPlaneMatrix projection
    // Unpitched point labels need to have their rotation applied after projection
    const rotateInShader = rotateWithMap && !pitchWithMap && !alongLine;

    const depthMode = painter.depthModeForSublayer(0, DepthMode.ReadOnly);

    let program;
    let size;

    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);
        const bucket: SymbolBucket = (tile.getBucket(layer): any);
        if (!bucket) continue;
        const buffers = isText ? bucket.text : bucket.icon;
        if (!buffers || !buffers.segments.get().length) continue;
        const programConfiguration = buffers.programConfigurations.get(layer.id);

        const isSDF = isText || bucket.sdfIcons;

        const sizeData = isText ? bucket.textSizeData : bucket.iconSizeData;

        if (!program) {
            program = painter.useProgram(isSDF ? 'symbolSDF' : 'symbolIcon', programConfiguration);
            size = symbolSize.evaluateSizeForZoom(sizeData, tr.zoom, symbolLayoutProperties.properties[isText ? 'text-size' : 'icon-size']);
        }

        context.activeTexture.set(gl.TEXTURE0);

        let texSize: [number, number];
        let atlasTexture;
        let atlasInterpolation;
        if (isText) {
            atlasTexture = tile.glyphAtlasTexture;
            atlasInterpolation = gl.LINEAR;
            texSize = tile.glyphAtlasTexture.size;

        } else {
            const iconScaled = layer.layout.get('icon-size').constantOr(0) !== 1 || bucket.iconsNeedLinear;
            const iconTransformed = pitchWithMap || tr.pitch !== 0;

            atlasTexture = tile.imageAtlasTexture;
            atlasInterpolation = isSDF || painter.options.rotating || painter.options.zooming || iconScaled || iconTransformed ?
                gl.LINEAR :
                gl.NEAREST;
            texSize = tile.imageAtlasTexture.size;
        }

        if (!sortByFeature) {
            atlasTexture.bind(atlasInterpolation, gl.CLAMP_TO_EDGE);
        }

        const s = pixelsToTileUnits(tile, 1, painter.transform.zoom);
        const labelPlaneMatrix = symbolProjection.getLabelPlaneMatrix(coord.posMatrix, pitchWithMap, rotateWithMap, painter.transform, s);
        const glCoordMatrix = symbolProjection.getGlCoordMatrix(coord.posMatrix, pitchWithMap, rotateWithMap, painter.transform, s);

        if (alongLine) {
            symbolProjection.updateLineLabels(bucket, coord.posMatrix, painter, isText, labelPlaneMatrix, glCoordMatrix, pitchWithMap, keepUpright);
        }

        const matrix = painter.translatePosMatrix(coord.posMatrix, tile, translate, translateAnchor),
            uLabelPlaneMatrix = alongLine ? identityMat4 : labelPlaneMatrix,
            uglCoordMatrix = painter.translatePosMatrix(glCoordMatrix, tile, translate, translateAnchor, true);

        const hasHalo = isSDF && layer.paint.get(isText ? 'text-halo-width' : 'icon-halo-width').constantOr(1) !== 0;

        let uniformValues;
        if (isSDF) {

            uniformValues = symbolSDFUniformValues(sizeData.functionType,
                size, rotateInShader, pitchWithMap, painter, matrix,
                uLabelPlaneMatrix, uglCoordMatrix, isText, texSize, true);

            if (!sortByFeature) {
                if (hasHalo) {
                    drawSymbolElements(buffers, buffers.segments, layer, painter, program, depthMode, stencilMode, colorMode, uniformValues);
                }
                uniformValues['u_is_halo'] = 0;
            }

        } else {
            uniformValues = symbolIconUniformValues(sizeData.functionType,
                size, rotateInShader, pitchWithMap, painter, matrix,
                uLabelPlaneMatrix, uglCoordMatrix, isText, texSize);
        }

        if (sortByFeature) {
            ((tileRenderState: any): Array<SymbolTileRenderState>).push({
                buffers,
                program,
                depthMode,
                uniformValues,
                atlasTexture,
                atlasInterpolation,
                isSDF,
                hasHalo
            });
        } else {
            atlasTexture.bind(atlasInterpolation, gl.CLAMP_TO_EDGE);
            drawSymbolElements(buffers, buffers.segments, layer, painter, program, depthMode, stencilMode, colorMode, uniformValues);
        }
    }
}

function drawSymbolElements(buffers, segments, layer, painter, program, depthMode, stencilMode, colorMode, uniformValues) {
    const context = painter.context;
    const gl = context.gl;
    program.draw(context, gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.disabled,
        uniformValues, layer.id, buffers.layoutVertexBuffer,
        buffers.indexBuffer, segments, layer.paint,
        painter.transform.zoom, buffers.programConfigurations.get(layer.id),
        buffers.dynamicLayoutVertexBuffer, buffers.opacityVertexBuffer);
}

function drawSymbolsSorted(painter: Painter, renderData: Array<SymbolTileRenderState>, layer, colorMode, stencilMode) {
    const symbols = [];

    for (const data of renderData) {

        const segments = data.buffers.segments.get();
        for (const segment of segments) {
            symbols.push({
                data,
                segment
            });
        }
    }

    symbols.sort((a, b) => a.segment.sortKey - b.segment.sortKey);

    for (const symbol of symbols) {
        const data = symbol.data;
        const segments = new SegmentVector([symbol.segment]);

        const gl = painter.context.gl;
        data.atlasTexture.bind(data.atlasInterpolation, gl.CLAMP_TO_EDGE);

        if (data.isSDF) {
            const uniformValues = ((data.uniformValues: any): UniformValues<SymbolSDFUniformsType>);
            if (data.hasHalo) {
                uniformValues['u_is_halo'] = 1;
                drawSymbolElements(data.buffers, segments, layer, painter, data.program, data.depthMode, stencilMode, colorMode, uniformValues);
            }
            data.uniformValues['u_is_halo'] = 0;
        }
        drawSymbolElements(data.buffers, segments, layer, painter, data.program, data.depthMode, stencilMode, colorMode, data.uniformValues);
    }
}

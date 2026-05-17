import { Canvas, createCanvas } from 'canvas';
import { Request, Response } from 'express';
import { createWriteStream, writeFile, WriteStream } from 'fs';
import GIFEncoder from 'gifencoder';
import { AvatarRenderManager, AvatarScaleType, IAvatarImage } from '../avatar';
import { File, FileUtilities, NitroLogger, Point } from '../core';
import { BuildFigureOptionsRequest, BuildFigureOptionsStringRequest, ProcessActionRequest, ProcessDanceRequest, ProcessDirectionRequest, ProcessEffectRequest, ProcessGestureRequest, RequestQuery } from './utils';

export const HttpRouter = async (request: Request<any, any, any, RequestQuery>, response: Response) =>
{
    const query = request.query;

    try
    {
        const buildOptions = BuildFigureOptionsRequest(query);

        const saveDirectory = (process.env.AVATAR_SAVE_PATH as string);

        const directory = FileUtilities.getDirectory(saveDirectory);

        const avatarString = BuildFigureOptionsStringRequest(buildOptions);

        const saveFile = new File(`${ directory.path }/${ avatarString }.${ buildOptions.imageFormat }`);

        if(saveFile.exists())
        {
            const buffer = await FileUtilities.readFileAsBuffer(saveFile.path);

            if(buffer)
            {
                response
                    .writeHead(200, {
                        'Content-Type': ((buildOptions.imageFormat === 'gif') ? 'image/gif' : 'image/png')
                    })
                    .end(buffer);
            }

            return;
        }

        if(buildOptions.effect > 0)
        {
            if(!AvatarRenderManager.instance.effectManager.isAvatarEffectReady(buildOptions.effect))
            {
                await AvatarRenderManager.instance.effectManager.downloadAvatarEffect(buildOptions.effect);
            }
        }

        const avatar = await AvatarRenderManager.instance.createAvatarImage(buildOptions.figure, AvatarScaleType.LARGE, 'M');

        const avatarCanvas = AvatarRenderManager.instance.structure.getCanvas(avatar.getScale(), avatar.mainAction.definition.geometryType);

        ProcessDirectionRequest(query, avatar);

        avatar.initActionAppends();

        ProcessActionRequest(query, avatar);

        ProcessGestureRequest(query, avatar);

        ProcessDanceRequest(query, avatar);

        ProcessEffectRequest(query, avatar);

        avatar.endActionAppends();

        const tempCanvas = createCanvas((avatarCanvas.width * buildOptions.size), (avatarCanvas.height * buildOptions.size));

        const tempCtx = tempCanvas.getContext('2d');

        tempCtx.imageSmoothingEnabled = false;

        // @ts-ignore
        tempCtx.quality = 'fast';

        let encoder: GIFEncoder = null;

        let stream: WriteStream = null;

        if(buildOptions.imageFormat === 'gif')
        {
            encoder = new GIFEncoder(tempCanvas.width, tempCanvas.height);

            stream = encoder.createReadStream().pipe(createWriteStream(saveFile.path));

            encoder.start();

            encoder.setRepeat(0);

            encoder.setDelay(80);

            encoder.setQuality(1);

            // @ts-ignore — setDispose exists at runtime but is missing from @types/gifencoder
            encoder.setDispose(2);

            encoder.setTransparent(0x00ff00);
        }

        let totalFrames = 0;

        if(buildOptions.imageFormat !== 'gif')
        {
            if(buildOptions.frameNumber > 0) avatar.updateAnimationByFrames(buildOptions.frameNumber);

            totalFrames = 1;
        }
        else
        {
            totalFrames = (avatar.getTotalFrameCount() || 8);
        }

        for(let i = 0; i < totalFrames; i++)
        {
            // Reset totale del contesto
            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

            // GIF only: solid bg becomes transparent key via flood-fill. PNG has native alpha.
            if(buildOptions.imageFormat === 'gif')
            {
                tempCtx.fillStyle = '#fefefe';

                tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
            }

            if(totalFrames && (i > 0)) avatar.updateAnimationByFrames(1);

            const canvas = await avatar.getImage(buildOptions.setType, 0, false, buildOptions.size);

            if(!canvas || canvas.width === 0) continue;

            const avatarOffset = new Point();

            let canvasOffsets = avatar.getCanvasOffsets();

            if(!canvasOffsets || !canvasOffsets.length) canvasOffsets = [ 0, 0, 0 ];

            const postureOffset = 0;

            avatarOffset.x = ((((-1 * 64) / 2) + canvasOffsets[0]) - ((canvas.width - 64) / 2));

            avatarOffset.y = (((-(canvas.height) + (64 / 4)) + canvasOffsets[1]) + postureOffset);

            const otherOffset = new Point(0, -16);

            for(const sprite of avatar.getSprites())
            {
                if(sprite.id === 'avatar')
                {
                    const layerData = avatar.getLayerData(sprite);

                    let offsetX = sprite.getDirectionOffsetX(buildOptions.direction);

                    let offsetY = sprite.getDirectionOffsetY(buildOptions.direction);

                    if(layerData)
                    {
                        offsetX += layerData.dx;

                        offsetY += layerData.dy;
                    }

                    const canStandUp = false;

                    if(!canStandUp)
                    {
                        avatarOffset.x += offsetX;

                        avatarOffset.y += offsetY;
                    }
                }
            }

            const avatarSize = 64;

            const sizeOffset = new Point(((canvas.width - avatarSize) / 2), (canvas.height - (avatarSize / 4)));

            ProcessAvatarSprites(tempCanvas, avatar, otherOffset, false);

            tempCtx.save();

            tempCtx.imageSmoothingEnabled = false;

            tempCtx.drawImage(canvas, ((canvas.width / 2) + avatarOffset.x), (canvas.height + avatarOffset.y) + otherOffset.y, canvas.width, canvas.height);

            tempCtx.restore();

            ProcessAvatarSprites(tempCanvas, avatar, otherOffset, true);

            if(encoder)
            {
                // Snapshot the frame so the encoder doesn't read a canvas Nitro is resetting.
                const frameCanvas = createCanvas(tempCanvas.width, tempCanvas.height);
                const frameCtx = frameCanvas.getContext('2d');
                frameCtx.imageSmoothingEnabled = false;
                frameCtx.drawImage(tempCanvas, 0, 0);

                // Flood-fill from the 4 edges: any pixel close to the background colour
                // that is connected to the border becomes the transparent key (#00ff00).
                // White islands trapped inside the avatar's silhouette stay intact —
                // that is what makes hoodie zips, eye highlights, etc. survive.
                const w = frameCanvas.width;
                const h = frameCanvas.height;
                const imageData = frameCtx.getImageData(0, 0, w, h);
                const data = imageData.data;
                const visited = new Uint8Array(w * h);
                const stack: number[] = [];
                for(let x = 0; x < w; x++)
                {
                    stack.push(x, 0);
                    stack.push(x, h - 1);
                }
                for(let y = 1; y < h - 1; y++)
                {
                    stack.push(0, y);
                    stack.push(w - 1, y);
                }
                while(stack.length > 0)
                {
                    const py = stack.pop() as number;
                    const px = stack.pop() as number;
                    if(px < 0 || px >= w || py < 0 || py >= h) continue;
                    const idx = py * w + px;
                    if(visited[idx]) continue;
                    visited[idx] = 1;
                    const pidx = idx * 4;
                    const r = data[pidx];
                    const g = data[pidx + 1];
                    const b = data[pidx + 2];
                    // "near white" + near-greyscale (avoids matching skin tones like rgb(255,224,196)).
                    // Threshold pushed down to 180 to catch anti-aliased halo around the avatar.
                    if(r > 180 && g > 180 && b > 180 && Math.abs(r - g) < 25 && Math.abs(g - b) < 25)
                    {
                        data[pidx]     = 0x00;
                        data[pidx + 1] = 0xff;
                        data[pidx + 2] = 0x00;
                        stack.push(px + 1, py);
                        stack.push(px - 1, py);
                        stack.push(px, py + 1);
                        stack.push(px, py - 1);
                    }
                }
                // Anchor pixels: force a 6-pixel-thick green border on all 4 sides
                // so NeuQuant always keeps 0x00ff00 in the per-frame Local Color
                // Table, even on frames where the avatar covers most of the canvas.
                for(let ring = 0; ring < 6; ring++)
                {
                    for(let ax = 0; ax < w; ax++)
                    {
                        const top = (ring * w + ax) * 4;
                        const bot = ((h - 1 - ring) * w + ax) * 4;
                        data[top]     = 0x00; data[top + 1]     = 0xff; data[top + 2]     = 0x00;
                        data[bot]     = 0x00; data[bot + 1]     = 0xff; data[bot + 2]     = 0x00;
                    }
                    for(let ay = 0; ay < h; ay++)
                    {
                        const left  = (ay * w + ring) * 4;
                        const right = (ay * w + (w - 1 - ring)) * 4;
                        data[left]    = 0x00; data[left + 1]    = 0xff; data[left + 2]    = 0x00;
                        data[right]   = 0x00; data[right + 1]   = 0xff; data[right + 2]   = 0x00;
                    }
                }
                frameCtx.putImageData(imageData, 0, 0);

                encoder.addFrame(frameCtx as any);
            }
            else
            {
                // PNG: flood-fill from edges -> alpha 0 on near-white connected pixels.
                // Same idea as GIF transparent key, but writes to alpha channel directly.
                {
                    const w = tempCanvas.width;
                    const h = tempCanvas.height;
                    const imageData = tempCtx.getImageData(0, 0, w, h);
                    const data = imageData.data;
                    const visited = new Uint8Array(w * h);
                    const stack: number[] = [];
                    for(let x = 0; x < w; x++)
                    {
                        stack.push(x, 0);
                        stack.push(x, h - 1);
                    }
                    for(let y = 1; y < h - 1; y++)
                    {
                        stack.push(0, y);
                        stack.push(w - 1, y);
                    }
                    while(stack.length > 0)
                    {
                        const py = stack.pop() as number;
                        const px = stack.pop() as number;
                        if(px < 0 || px >= w || py < 0 || py >= h) continue;
                        const idx = py * w + px;
                        if(visited[idx]) continue;
                        visited[idx] = 1;
                        const pidx = idx * 4;
                        const r = data[pidx];
                        const g = data[pidx + 1];
                        const b = data[pidx + 2];
                        if(r > 180 && g > 180 && b > 180 && Math.abs(r - g) < 25 && Math.abs(g - b) < 25)
                        {
                            data[pidx + 3] = 0;
                            stack.push(px + 1, py);
                            stack.push(px - 1, py);
                            stack.push(px, py + 1);
                            stack.push(px, py - 1);
                        }
                    }
                    tempCtx.putImageData(imageData, 0, 0);
                }

                const buffer = tempCanvas.toBuffer();

                response
                    .writeHead(200, {
                        'Content-Type': 'image/png'
                    })
                    .end(buffer);

                writeFile(saveFile.path, buffer, () =>
                {});

                return;
            }
        }

        if(encoder) encoder.finish();

        if(stream)
        {
            await new Promise((resolve, reject) =>
            {
                stream.on('finish', () => resolve(null));

                stream.on('error', reject);
            });
        }

        let buffer = await FileUtilities.readFileAsBuffer(saveFile.path);

        // Per-frame transparent-index patch.
        //
        // gifencoder picks the transparent palette index with `findClosest`, which
        // can disagree with NeuQuant's `lookupRGB` — meaning the index marked as
        // transparent doesn't match the index the green anchor pixels were actually
        // quantized to. The fix: for every frame, read the LZW-encoded index of the
        // top-left pixel (guaranteed green by the 6-pixel anchor border) and force
        // the GCE transparent index to that same value.
        if(buildOptions.imageFormat === 'gif' && buffer.length > 13 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
        {
            patchGifTransparentIndex(buffer);
            await new Promise<void>((resolve, reject) =>
            {
                writeFile(saveFile.path, buffer, (err) =>
                {
                    if(err) reject(err);
                    else resolve();
                });
            });
        }

        response
            .writeHead(200, {
                'Content-Type': 'image/gif'
            })
            .end(buffer);
    }

    catch (err)
    {
        NitroLogger.error(err.message);

        response
            .writeHead(500)
            .end();
    }
};

/**
 * Walk the GIF byte-by-byte and, for every frame, rewrite the Graphic Control
 * Extension transparent index to match the palette index of the top-left pixel
 * of that frame's image data. Since the canvas has a 6-pixel green anchor border
 * before encoding, that top-left pixel is always the green key — so the GCE ends
 * up pointing at whatever palette index NeuQuant actually mapped the green to,
 * regardless of how findClosest disagreed.
 */
function patchGifTransparentIndex(buf: Buffer): void
{
    if(buf.length < 13) return;
    const packed = buf[10];
    const gctSize = (packed & 0x80) !== 0 ? (1 << ((packed & 0x07) + 1)) : 0;
    let pos = 13 + gctSize * 3;
    let lastGcePos = -1;

    while(pos < buf.length)
    {
        const b = buf[pos];
        if(b === 0x3B) break;

        if(b === 0x21)
        {
            const label = buf[pos + 1];
            if(label === 0xF9)
            {
                lastGcePos = pos;
                pos += 8;
            }
            else
            {
                pos += 2;
                while(pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1;
                pos += 1;
            }
        }
        else if(b === 0x2C)
        {
            const ipacked = buf[pos + 9];
            const hasLCT = (ipacked & 0x80) !== 0;
            const lctSize = hasLCT ? (1 << ((ipacked & 0x07) + 1)) : 0;
            pos += 10 + (lctSize * 3);

            if(pos >= buf.length) break;
            const minCodeSize = buf[pos];
            pos += 1;

            // Decode just enough LZW to read the first emitted code (= first pixel index).
            const subSize = buf[pos];
            if(subSize > 0 && lastGcePos !== -1)
            {
                const codeSize = minCodeSize + 1;
                const clearCode = 1 << minCodeSize;
                const codeMask = (1 << codeSize) - 1;
                let bits = 0;
                let bufBits = 0;
                let bp = pos + 1;

                while(bits < codeSize && bp < pos + 1 + subSize)
                {
                    bufBits |= buf[bp] << bits;
                    bits += 8;
                    bp++;
                }
                let code = bufBits & codeMask;
                bufBits >>>= codeSize;
                bits -= codeSize;

                if(code === clearCode)
                {
                    while(bits < codeSize && bp < pos + 1 + subSize)
                    {
                        bufBits |= buf[bp] << bits;
                        bits += 8;
                        bp++;
                    }
                    code = bufBits & codeMask;
                }

                if(code >= 0 && code <= 0xff)
                {
                    buf[lastGcePos + 3] |= 0x01;
                    buf[lastGcePos + 6] = code;
                }
            }

            while(pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1;
            pos += 1;
        }
        else
        {
            break;
        }
    }
}

function ProcessAvatarSprites(canvas: Canvas, avatar: IAvatarImage, offset: Point, frontSprites: boolean = true)
{
    const ctx = canvas.getContext('2d');

    for(const sprite of avatar.getSprites())
    {
        const layerData = avatar.getLayerData(sprite);

        let offsetX = sprite.getDirectionOffsetX(avatar.getDirection());

        let offsetY = sprite.getDirectionOffsetY(avatar.getDirection());

        const offsetZ = sprite.getDirectionOffsetZ(avatar.getDirection());

        let direction = 0;

        let frame = 0;

        if(!frontSprites)
        {
            if(offsetZ >= 0) continue;
        }
        else if(offsetZ < 0) continue;

        if(sprite.hasDirections) direction = avatar.getDirection();

        if(layerData)
        {
            frame = layerData.animationFrame;

            offsetX += layerData.dx;

            offsetY += layerData.dy;

            direction += layerData.dd;
        }

        if(direction < 0) direction = (direction + 8);

        else if(direction > 7) direction = (direction - 8);

        const assetName = ((((((avatar.getScale() + '_') + sprite.member) + '_') + direction) + '_') + frame);

        const asset = avatar.getAsset(assetName);

        if(!asset) continue;

        const texture = asset.texture;

        const x = ((((canvas.width / 2) + asset.offsetX) - (64 / 2)) + offsetX) + offset.x;

        const y = ((canvas.height + asset.offsetY) + offsetY) + offset.y;

        ctx.save();

        ctx.drawImage(texture.drawableCanvas, x, y, texture.width, texture.height);

        ctx.restore();
    }
}
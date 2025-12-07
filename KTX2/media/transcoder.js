// transcoder.js - LibKTX ES Module for KTX2 transcoding

let ktxModule = null;

/**
 * Initialize libktx WebAssembly module
 */
async function initLibKTX() {
  if (ktxModule) return ktxModule;

  // Verify LIBKTX loaded
  if (typeof window.LIBKTX === 'undefined') {
    throw new Error('LIBKTX global not found. Ensure libktx.js is loaded in extension.ts.');
  }

  try {
    console.log('Initializing LIBKTX module...');
    const mod = await window.LIBKTX({
      locateFile: (path) => {
        if (path.endsWith('.wasm')) {
          // FIXED: Matches the variable set in extension.ts
          return window.LIBKTX_WASM; 
        }
        return path;
      },
      onRuntimeInitialized: () => {
        console.log('✓ libktx module initialized');
      }
    });

    ktxModule = mod;
    return mod;
  } catch (err) {
    console.error('libktx init failed:', err);
    throw err;
  }
}

// returns { instance: wasmExports, memory, createViews }
async function instantiateUASTCTranscoder(wasmUrl, nBlocks /* number of 4x4 blocks to plan for */) {
  // 16 bytes per block for UASTC -> ASTC/BC7; ensure enough pages (+1 reserved page)
  const bytesNeeded = nBlocks * 16;
  const texMemoryPages = (bytesNeeded + 65535) >> 16; // pages for compressed data
  // +1 reserved page for WASM internal use
  const memory = new WebAssembly.Memory({ initial: texMemoryPages + 1 });

  // Create the initial view into memory where UASTC blocks will be placed.
  // The guide reserves the 0th page, data starts at offset 65536.
  function makeViews() {
    const base = 65536;
    const compressedBytes = nBlocks * 16;
    const compressedView = new Uint8Array(memory.buffer, base, compressedBytes);
    return { compressedView, memoryBase: base, compressedBytes };
  }

  const resp = await fetch(wasmUrl);
  const bytes = await resp.arrayBuffer();
  const module = await WebAssembly.instantiate(bytes, { env: { memory } });
  const instance = module.instance.exports;

  // If the transcoder needs other imports (like table, abort), adapt as needed.
  return { instance, memory, makeViews };
}

// instance = wasmExports from instantiateUASTCTranscoder
// makeViews() returns { compressedView, memoryBase, compressedBytes }
async function transcodeUASTCToBC7(wasmUrl, uastcBlocks, width, height) {
  const nBlocks = ((width + 3) >> 2) * ((height + 3) >> 2);
  const { instance, memory, makeViews } = await instantiateUASTCTranscoder(wasmUrl, nBlocks);
  let { compressedView } = makeViews();

  // copy raw UASTC (each block 16 bytes) into compressed area
  if (uastcBlocks.byteLength !== nBlocks * 16) {
    // If KTX2 stores blocks contiguous and smaller, adjust accordingly.
    // But generally uastcBlocks.length should equal nBlocks*16
    console.warn('uastcBlocks length mismatch', uastcBlocks.byteLength, nBlocks * 16);
  }
  compressedView.set(uastcBlocks.subarray(0, nBlocks * 16));

  // call transcode(numBlocks) — Khronos transcoders usually expose `transcode` or `transcode_blocks`
  // The exact exported function name depends on the WASM build. Check instance exports.
  if (typeof instance.transcode !== 'function') {
    throw new Error('WASM transcoder has no transcode() export; inspect instance.exports');
  }

  const ret = instance.transcode(nBlocks); // returns 0 on success per guide
  if (ret !== 0) throw new Error('Transcode returned error ' + ret);

  // After success, compressedView now contains BC7 blocks (16 bytes per block)
  // Return a copy so we can free or re-use WASM memory
  return new Uint8Array(compressedView);
}

// Decode to RGBA8 using the Khronos decoder
async function decodeUASTCToRGBA(wasmUrl, uastcBlocks, width, height) {
  const xBlocks = (width + 3) >> 2;
  const yBlocks = (height + 3) >> 2;
  const compressedByteLength = xBlocks * yBlocks * 16;
  const uncompressedByteLength = width * yBlocks * 4 * 4; // padded rows to multiple-of-4 height
  const totalByteLength = compressedByteLength + uncompressedByteLength;
  const texMemoryPages = (totalByteLength + 65535) >> 16;

  const memory = new WebAssembly.Memory({ initial: texMemoryPages + 1 });
  const base = 65536;
  const compressedView = new Uint8Array(memory.buffer, base, compressedByteLength);
  const decodedView = new Uint8Array(memory.buffer, base + compressedByteLength, uncompressedByteLength);

  // copy compressed blocks
  compressedView.set(uastcBlocks.subarray(0, compressedByteLength));

  // instantiate wasm with that memory
  const resp = await fetch(wasmUrl);
  const module = await WebAssembly.instantiate(await resp.arrayBuffer(), { env: { memory } });
  const instance = module.instance.exports;

  // exported function is usually decode(width, height)
  if (typeof instance.decode !== 'function') throw new Error('Decoder has no decode(width,height) export');

  const r = instance.decode(width, height);
  if (r !== 0) throw new Error('Decode failed: ' + r);

  // decodedView now contains width*height*4 bytes in RGBA8 (row-packed)
  // Note: some decoders pad rows to multiple-of-4 height - your `decodedView` already accounts for yBlocks.
  // Create a copy to detach from WASM Memory
  return new Uint8Array(decodedView);
}


/**
 * Transcode entire KTX2 file (handles Basis Universal supercompression)
 */
async function transcodeFullKTX2(fileBuffer) {
  const m = await initLibKTX();

  let texture = null;
  try {
    // 1. LOAD TEXTURE
    try {
      const data = new Uint8Array(fileBuffer);
      texture = new m.ktxTexture(data);
    } catch (e) {
      throw new Error(`Failed to create ktxTexture: ${e.message}`);
    }
    
    // 2. CHECK TRANSCODING NEEDS
    let shouldTranscode = false;
    if (texture.needsTranscoding && typeof texture.needsTranscoding === 'function') {
      shouldTranscode = texture.needsTranscoding;
    } else if (texture.vkFormat === 0) {
      shouldTranscode = true;
    }

    // 3. TRANSCODE
    if (shouldTranscode) {
      let targetFormat = (
        m.TranscodeTarget?.BC7_RGBA?.value ??
        m.TranscodeTarget?.BC7_RGBA ??
        0x93 
      );

      if (m.TranscodeTarget && m.TranscodeTarget.BC7_M5_RGBA !== undefined) {
        targetFormat = m.TranscodeTarget.BC7_M5_RGBA.value || m.TranscodeTarget.BC7_M5_RGBA;
      }
      
      if (!texture.transcodeBasis(targetFormat, 0)) {
        throw new Error("libktx transcoding failed");
      }
    }

  // 4. GET TEXTURE DATA
    const mips = [];
    const numLevels = texture.numLevels || 1; // Default to 1 if property is missing

    for (let i = 0; i < numLevels; i++) {
      let mipData = null;

      // Use the API exposed in your log: getImage(level, layer, face)
      if (texture.getImage) {
          mipData = texture.getImage(i, 0, 0);
      } else {
          throw new Error("texture.getImage() is missing, but required for this libktx version.");
      }

      // If it returns a view into WASM memory, we MUST copy it
      // because texture.delete() will invalidate the memory.
      const mipCopy = new Uint8Array(mipData);

      mips.push({
        data: mipCopy,
        width: Math.max(1, texture.baseWidth >> i),
        height: Math.max(1, texture.baseHeight >> i)
      });
    }

    return mips;

  } catch(e) {
    console.error("KTX2 Processing Error:", e);
    throw e;
  } finally {
    if (texture && texture.delete) texture.delete();
  }
}
// --- HELPER FUNCTIONS ---

const NATIVE_BC_FORMATS = {
  131: 'bc1-rgba-unorm', 132: 'bc1-rgba-unorm-srgb',
  135: 'bc2-rgba-unorm', 136: 'bc2-rgba-unorm-srgb',
  137: 'bc3-rgba-unorm', 138: 'bc3-rgba-unorm-srgb',
  139: 'bc4-r-unorm', 140: 'bc4-r-snorm',
  141: 'bc5-rg-unorm', 142: 'bc5-rg-snorm',
  143: 'bc6h-rgb-ufloat', 144: 'bc6h-rgb-float',
  145: 'bc7-rgba-unorm', 146: 'bc7-rgba-unorm-srgb',
  //152: 'etc2-rgba8unorm', 153: 'etc2-rgba8unorm-srgb',
};

function checkFormatRequirements(vkFormat) {
  if (NATIVE_BC_FORMATS[vkFormat]) {
    return { needsProcessing: false, format: NATIVE_BC_FORMATS[vkFormat], vkFormat: vkFormat };
  }
  return null;
} 

function getFormatName(vkFormat) {
  return NATIVE_BC_FORMATS[vkFormat] || `VK Format ${vkFormat}`;
}

function vkFormatToWebGPU(vkFormat) {
  const format = NATIVE_BC_FORMATS[vkFormat];
  if (!format) return null;
  return { format, blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 };
}

// --- EXPORTS ---
export {
  initLibKTX,
  transcodeFullKTX2,
  checkFormatRequirements,
  getFormatName,
  vkFormatToWebGPU,
  NATIVE_BC_FORMATS
};

// Attach to window for fallback compatibility
window.initLibKTX = initLibKTX;
window.transcodeFullKTX2 = transcodeFullKTX2;
window.checkFormatRequirements = checkFormatRequirements;
window.getFormatName = getFormatName;
window.vkFormatToWebGPU = vkFormatToWebGPU;
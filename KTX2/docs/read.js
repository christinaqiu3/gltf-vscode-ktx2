// File for parsing KTX2 files
// | Identifier | Header | Level Index | DFD | KVD | SGD | Mip Level Array |

async function parseKTX2(arrayBuffer) {
  const dv = new DataView(arrayBuffer);

  // Identifier (12 bytes) - validates that this is truly ktx2 file
  const identifier = new Uint8Array(arrayBuffer, 0, 12);
  const KTX2_IDENTIFIER = new Uint8Array([0xAB,0x4B,0x54,0x58,0x20,0x32,0x30,0xBB,0x0D,0x0A,0x1A,0x0A]);
  for (let i = 0; i < 12; i++) {
    if (identifier[i] !== KTX2_IDENTIFIER[i]) throw new Error('Invalid KTX2 identifier');
  }

  if (arrayBuffer.byteLength < 12 + 68) {
    throw new Error('KTX2 too small to contain header.');
  }

  // Header (68 bytes) - Describes global properties of the texture (dimensions, format, data locations, etc.)
  let offset = 12; // After identifier which is 12 bytes
  const header = {
    vkFormat: dv.getUint32(offset, true), offset: (offset += 4), // Vulkan format enum (texture type)
    typeSize: dv.getUint32(offset, true), offset: (offset += 4), // Size of a single texel block in bytes
    pixelWidth: dv.getUint32(offset, true), offset: (offset += 4), // Width of the texture in pixels
    pixelHeight: dv.getUint32(offset, true), offset: (offset += 4), // Height of the texture in pixels
    pixelDepth: dv.getUint32(offset, true), offset: (offset += 4), // Depth of the texture in pixels (1 for 2D textures)
    layerCount: dv.getUint32(offset, true), offset: (offset += 4), /// Number of array layers
    faceCount: dv.getUint32(offset, true), offset: (offset += 4), // Number of faces (6 for cubemaps)
    levelCount: dv.getUint32(offset, true), offset: (offset += 4), // Number of mip levels
    supercompressionScheme: dv.getUint32(offset, true), offset: (offset += 4), // Supercompression scheme used (0 = none)
  };

  // Indexing of data blocks
  const index = {
    dfdByteOffset: dv.getUint32(offset, true), offset: (offset += 4), // Data Format Descriptor
    dfdByteLength: dv.getUint32(offset, true), offset: (offset += 4), // Length of DFD block
    kvdByteOffset: dv.getUint32(offset, true), offset: (offset += 4), // Key/Value Data
    kvdByteLength: dv.getUint32(offset, true), offset: (offset += 4), // Length of KVD block
    sgdByteOffset: Number(dv.getBigUint64(offset, true)), offset: (offset += 8), // Supercompression Global Data
    sgdByteLength: Number(dv.getBigUint64(offset, true)), offset: (offset += 8), // Length of SGD block
  };

  // Level Index - array of mip levels
  const levelCount = Math.max(1, header.levelCount || 1);
  const levels = [];
  for (let i = 0; i < levelCount; i++) {
    const byteOffset = Number(dv.getBigUint64(offset, true)); offset += 8;
    const byteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    const uncompressedByteLength = Number(dv.getBigUint64(offset, true)); offset += 8;
    levels.push({
      byteOffset, byteLength, uncompressedByteLength,
      width: Math.max(1, header.pixelWidth  >> i),
      height: Math.max(1, header.pixelHeight >> i),
    });
  }

  // Parse DFD if present
  let dfd = null;
  if (index.dfdByteLength > 0) {
    dfd = parseDFD(dv, index.dfdByteOffset, index.dfdByteLength);
  }

  // Parse KVD if present
  let kvd = null;
  if (index.kvdByteLength > 0) {
    kvd = parseKVD(dv, index.kvdByteOffset, index.kvdByteLength);
  }

  return { header, index, levels, dfd, kvd };
}

// DFD data block parser
function parseDFD(dv, baseOffset, length) {
  const view = new DataView(dv.buffer, baseOffset, length);
  let offset = 0;
  const totalSize = view.getUint32(offset, true); offset += 4;
  const vendorId = view.getUint16(offset, true); offset += 2;
  const descriptorType = view.getUint16(offset, true); offset += 2;
  const versionNumber = view.getUint16(offset, true); offset += 2;
  const descriptorBlockSize = view.getUint16(offset, true); offset += 2;

  const colorModel = view.getUint8(offset++); 
  const colorPrimaries = view.getUint8(offset++);
  const transferFunction = view.getUint8(offset++);
  const flags = view.getUint8(offset++);

  const texelBlockDimension = [
    view.getUint8(offset++), view.getUint8(offset++),
    view.getUint8(offset++), view.getUint8(offset++)
  ];

  const bytesPlane = [];
  for (let i = 0; i < 8; i++) bytesPlane.push(view.getUint8(offset++));

  return { totalSize, vendorId, descriptorType, versionNumber,
          colorModel, colorPrimaries, transferFunction, flags,
          texelBlockDimension, bytesPlane, descriptorBlockSize };
}

// KVD data block parser
function parseKVD(dv, baseOffset, length) {
  const kv = {};
  let offset = baseOffset;
  while (offset < baseOffset + length) {
    const kvByteLength = dv.getUint32(offset, true); offset += 4;
    if (kvByteLength === 0) break; // Safety check
    const bytes = new Uint8Array(dv.buffer, offset, kvByteLength);
    const str = new TextDecoder().decode(bytes);
    const nullPos = str.indexOf('\0');
    if (nullPos >= 0) {
      const key = str.slice(0, nullPos);
      const value = str.slice(nullPos + 1);
      kv[key] = value;
    }
    offset += kvByteLength;
    offset += (4 - (kvByteLength % 4)) % 4; // 4-byte align
  }
  return kv;
}

// Mip level accessor
function getLevelData(arrayBuffer, level) {
  return new Uint8Array(arrayBuffer, level.byteOffset, level.byteLength);
}

// Vulkan format enum to WebGPU format string + metadata
// Returns: { format: 'bc7-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 }
function vkFormatToWebGPU(vkFormat) {
  console.log('vkFormatToWebGPU called with:', vkFormat);
  const formats = {
    // BC1 (DXT1) - 4x4 blocks, 8 bytes per block
    131: { format: 'bc1-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    132: { format: 'bc1-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    
    // BC2 (DXT3) - 4x4 blocks, 16 bytes per block
    135: { format: 'bc2-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    136: { format: 'bc2-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC3 (DXT5) - 4x4 blocks, 16 bytes per block
    137: { format: 'bc3-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    138: { format: 'bc3-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC4 (RGTC1) - 4x4 blocks, 8 bytes per block
    139: { format: 'bc4-r-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    140: { format: 'bc4-r-snorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    
    // BC5 (RGTC2) - 4x4 blocks, 16 bytes per block
    141: { format: 'bc5-rg-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    142: { format: 'bc5-rg-snorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC6H (HDR) - 4x4 blocks, 16 bytes per block
    143: { format: 'bc6h-rgb-ufloat', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    144: { format: 'bc6h-rgb-float', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // BC7 - 4x4 blocks, 16 bytes per block
    145: { format: 'bc7-rgba-unorm', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    146: { format: 'bc7-rgba-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },

    // --- MOBILE FORMATS ---

    // ETC1 formats - 4x4 blocks, 8 bytes per block (RGB only, no alpha)
    // Note: WebGPU doesn't have native ETC1, but we can use ETC2 which is backward compatible
    148: { format: "etc2-rgb8unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }, // ETC1 RGB
    149: { format: "etc2-rgb8unorm-srgb", blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 }, // ETC1 RGB sRGB

    // ETC2 formats - 4x4 blocks
    // Note: bytesPerBlock here is initial value, will be overridden by DFD if present
    152: { format: "etc2-rgb8unorm",  blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    153: { format: "etc2-rgb8a1unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 },
    154: { format: "etc2-rgba8unorm", blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    
    // ASTC UNORM
    157: { format: 'astc-4x4-unorm', blockWidth:4, blockHeight:4, bytesPerBlock:16 },
    159: { format: 'astc-5x4-unorm', blockWidth:5, blockHeight:4, bytesPerBlock:16 },
    161: { format: 'astc-5x5-unorm', blockWidth:5, blockHeight:5, bytesPerBlock:16 },
    163: { format: 'astc-6x5-unorm', blockWidth:6, blockHeight:5, bytesPerBlock:16 },
    165: { format: 'astc-6x6-unorm', blockWidth:6, blockHeight:6, bytesPerBlock:16 },
    
    // ASTC sRGB
    158: { format: 'astc-4x4-unorm-srgb', blockWidth:4, blockHeight:4, bytesPerBlock:16 },
    160: { format: 'astc-4x4-unorm-srgb', blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 },
    162: { format: 'astc-5x5-unorm-srgb', blockWidth:5, blockHeight:5, bytesPerBlock:16 },
    164: { format: 'astc-6x5-unorm-srgb', blockWidth:6, blockHeight:5, bytesPerBlock:16 },
    166: { format: 'astc-6x6-unorm-srgb', blockWidth:6, blockHeight:6, bytesPerBlock:16 },
    
    // --- UNCOMPRESSED FORMATS ---

    // RGB8 (UNORM & SRGB) — source data is 3-channel, must be expanded to RGBA8
    23: { format: 'rgba8unorm',       bytesPerPixel: 4, sourceChannels: 3 },
    24: { format: 'rgba8unorm-srgb',  bytesPerPixel: 4, sourceChannels: 3 },
    29: { format: 'rgba8unorm',       bytesPerPixel: 4, sourceChannels: 3 },

    // RGBA8
    37: { format: 'rgba8unorm',      bytesPerPixel: 4 },
    43: { format: 'rgba8unorm-srgb', bytesPerPixel: 4 },

    // RGBA16F — 8 bytes per pixel
    97: { format: 'rgba16float', bytesPerPixel: 8 },

    // RGBA32F — convert float32 → float16 first
    109: { format: 'rgba16float', bytesPerPixel: 8, sourceBytesPerPixel: 16 },

    // R11G11B10 UFLOAT
    100: { format: 'rg11b10ufloat', bytesPerPixel: 4 },
    122: { format: "rg11b10ufloat", bytesPerPixel: 4 },

    // RGB9E5 UFLOAT
    99:  { format: 'rgb9e5ufloat', bytesPerPixel: 4 },
    123: { format: 'rgb9e5ufloat', bytesPerPixel: 4 },

  };
  
  const result = formats[vkFormat] || null;
  console.log('vkFormatToWebGPU returning:', result);
  return result;
}

// Apply DFD corrections to format info
// The DFD (Data Format Descriptor) is authoritative over vkFormat header field
function applyDFDCorrections(formatInfo, dfd, vkFormat) {
  if (!formatInfo || !dfd) return formatInfo;
  
  // For block-compressed formats, trust DFD bytesPlane[0] over vkFormat
  if (formatInfo.blockWidth && dfd.bytesPlane && dfd.bytesPlane[0]) {
    const dfdBytesPerBlock = dfd.bytesPlane[0];
    
    if (dfdBytesPerBlock !== formatInfo.bytesPerBlock) {
      console.warn(`vkFormat ${vkFormat} claims ${formatInfo.bytesPerBlock} bytes/block, but DFD says ${dfdBytesPerBlock}. Using DFD value.`);
      
      // Update bytes per block - THIS IS THE KEY FIX
      formatInfo.bytesPerBlock = dfdBytesPerBlock;
      
      // For ETC2 formats, fix the WebGPU format string based on actual size
      // Also handles ETC1 (148-149) which WebGPU maps to ETC2
      if (vkFormat >= 148 && vkFormat <= 154) {
        if (dfdBytesPerBlock === 8) {
          // ETC1/ETC2 RGB or RGB with 1-bit alpha
          if (dfd.colorModel === 160) {
            formatInfo.format = 'etc2-rgb8unorm';
          } else if (dfd.colorModel === 162) {
            formatInfo.format = 'etc2-rgb8a1unorm';
          } else {
            // Default to RGB if colorModel is unclear
            formatInfo.format = 'etc2-rgb8unorm';
          }
        } else if (dfdBytesPerBlock === 16) {
          // ETC2 RGBA with full alpha
          formatInfo.format = 'etc2-rgba8unorm';
        }
      }
    }
  }
  
  return formatInfo;
}

// Get human-readable format name
function getFormatName(vkFormat) {
  const names = {
    131: 'BC1 (DXT1) UNORM', 132: 'BC1 (DXT1) SRGB',
    135: 'BC2 (DXT3) UNORM', 136: 'BC2 (DXT3) SRGB',
    137: 'BC3 (DXT5) UNORM', 138: 'BC3 (DXT5) SRGB',
    139: 'BC4 (RGTC1) UNORM', 140: 'BC4 (RGTC1) SNORM',
    141: 'BC5 (RGTC2) UNORM', 142: 'BC5 (RGTC2) SNORM',
    143: 'BC6H UFLOAT', 144: 'BC6H FLOAT',
    145: 'BC7 UNORM', 146: 'BC7 SRGB',
    148: 'ETC1 RGB', 149: 'ETC1 RGB SRGB',
    152: 'ETC2 RGB8', 153: 'ETC2 RGB8A1', 154: 'ETC2 RGBA8',
    157: 'ASTC 4x4 UNORM', 158: 'ASTC 4x4 SRGB',
    160: 'ASTC 4x4 SRGB',
  };
  return names[vkFormat] || `VK Format ${vkFormat}`;
}

function getSupercompressionName(scheme) {
  const names = {
    0: 'None',
    1: 'BasisLZ',
    2: 'Zstandard',
    3: 'ZLIB'
  };
  return names[scheme] || `Scheme ${scheme}`;
}

// Expose functions
window.parseKTX2 = parseKTX2;
window.vkFormatToWebGPU = vkFormatToWebGPU;
window.applyDFDCorrections = applyDFDCorrections;
window.getFormatName = getFormatName;
window.getSupercompressionName = getSupercompressionName;
window.parseDFD = parseDFD;
window.parseKVD = parseKVD;
window.getLevelData = getLevelData;

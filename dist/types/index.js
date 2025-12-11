"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChunkType = void 0;
/**
 * ChronicleChunk types
 * 1 = full (fully hydrated payload/Original Document)
 * 2 = delta (payload is only the changes since previous Chunk)
 */
var ChunkType;
(function (ChunkType) {
    ChunkType[ChunkType["FULL"] = 1] = "FULL";
    ChunkType[ChunkType["DELTA"] = 2] = "DELTA";
})(ChunkType || (exports.ChunkType = ChunkType = {}));
//# sourceMappingURL=index.js.map
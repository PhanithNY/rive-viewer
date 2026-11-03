export interface Encoder {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  _astc_init(): number
  _astc_release(): void
  _encode_astc(input: number, width: number, height: number, output: number, capacity: number): number
  _decode_astc(input: number, size: number, width: number, height: number, output: number, capacity: number): number
  _compress_lzfse(input: number, size: number, output: number, capacity: number): number
  _decompress_lzfse(input: number, size: number, output: number, capacity: number): number
}
export default function createEncoder(options?: { wasmBinary?: Uint8Array }): Promise<Encoder>

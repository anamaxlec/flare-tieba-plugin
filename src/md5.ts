export function md5Ascii(value: string): string {
  const message = Uint8Array.from(value, (char) => char.charCodeAt(0));
  const bitLengthLow = (message.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(message.length / 536870912) >>> 0;
  const paddedLength = (Math.floor((message.length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  for (let index = 0; index < 4; index += 1) {
    padded[paddedLength - 8 + index] = (bitLengthLow >>> (8 * index)) & 255;
    padded[paddedLength - 4 + index] = (bitLengthHigh >>> (8 * index)) & 255;
  }
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Array<number>(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        padded[wordOffset] |
        (padded[wordOffset + 1] << 8) |
        (padded[wordOffset + 2] << 16) |
        (padded[wordOffset + 3] << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const nextD = c;
      c = b;
      b = (b + rotateLeft((a + f + MD5_K[index] + words[g]) >>> 0, MD5_S[index])) >>> 0;
      a = d;
      d = nextD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return (
    littleEndianHex(a0) +
    littleEndianHex(b0) +
    littleEndianHex(c0) +
    littleEndianHex(d0)
  );
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

const MD5_K = (() => {
  const table = new Array<number>(64);
  for (let index = 0; index < 64; index += 1) {
    table[index] = Math.floor(
      Math.abs(Math.sin(index + 1)) * 4294967296,
    ) >>> 0;
  }
  return table;
})();

function littleEndianHex(value: number): string {
  const bytes = [
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  ];
  let output = "";
  for (const byte of bytes) {
    output += HEX[byte >>> 4] + HEX[byte & 15];
  }
  return output;
}

const HEX = "0123456789abcdef";

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

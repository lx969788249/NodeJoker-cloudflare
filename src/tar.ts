// 纯 JS tar.gz 提取器（Workers 兼容，利用内置 DecompressionStream）

export class TarGzReader {
  private buffer: Uint8Array | null = null;

  async load(tarGzBuffer: Uint8Array): Promise<void> {
    // gunzip
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(tarGzBuffer);
    writer.close();

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new Uint8Array(value));
      total += value.length;
    }

    // Flatten
    const tar = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      tar.set(c, offset);
      offset += c.length;
    }
    this.buffer = tar;
  }

  getFile(filename: string): Uint8Array | null {
    if (!this.buffer) return null;
    const buf = this.buffer;
    let pos = 0;

    while (pos + 512 <= buf.length) {
      // 读 header 中的文件名（前 100 字节）
      const nameEnd = buf.indexOf(0, pos);
      const name = new TextDecoder().decode(buf.slice(pos, nameEnd));

      // 读大小（offset 124-135, 12 字节八进制字符串）
      const sizeStr = new TextDecoder().decode(buf.slice(pos + 124, pos + 136)).replace(/\0/g, '').trim();
      const size = sizeStr ? parseInt(sizeStr, 8) : 0;

      if (name === filename || name === './' + filename) {
        // 文件数据：header 之后的下一个 512 对齐边界
        const dataStart = pos + 512;
        return buf.slice(dataStart, dataStart + size);
      }

      // 跳到下一个 header（data 向上取整到 512 的倍数）
      const dataBlocks = Math.ceil(size / 512);
      pos += 512 + dataBlocks * 512;

      // 检查是否到达结束（连续两个 512 字节的 0）
      if (pos >= buf.length) break;
    }
    return null;
  }
}

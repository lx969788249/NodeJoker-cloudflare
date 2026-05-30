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
    const entry = this.findEntry(filename);
    return entry ? entry.data : null;
  }

  // 遍历 tar 中所有文件，回调返回 { name, data }
  forEachFile(fn: (name: string, data: Uint8Array) => void): void {
    if (!this.buffer) return;
    const buf = this.buffer;
    let pos = 0;

    while (pos + 512 <= buf.length) {
      const nameEnd = buf.indexOf(0, pos);
      if (nameEnd === -1 || nameEnd > pos + 100) break;
      const name = new TextDecoder().decode(buf.slice(pos, nameEnd));
      if (!name) break; // 空文件名 = 结束标记

      const sizeStr = new TextDecoder().decode(buf.slice(pos + 124, pos + 136)).replace(/\0/g, '').trim();
      const size = sizeStr ? parseInt(sizeStr, 8) : 0;

      const dataStart = pos + 512;
      const cleanName = name.startsWith('./') ? name.slice(2) : name;

      if (size > 0 && dataStart + size <= buf.length) {
        fn(cleanName, buf.slice(dataStart, dataStart + size));
      }

      const dataBlocks = Math.ceil(size / 512);
      pos += 512 + dataBlocks * 512;
      if (pos >= buf.length) break;
    }
  }

  private findEntry(filename: string): { data: Uint8Array } | null {
    if (!this.buffer) return null;
    let result: { data: Uint8Array } | null = null;
    this.forEachFile((name, data) => {
      if (name === filename || name === './' + filename) result = { data };
    });
    return result;
  }
}
